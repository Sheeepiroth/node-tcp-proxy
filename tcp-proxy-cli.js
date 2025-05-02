#!/usr/bin/env node
var argv = require("commander");
var packageConfig = require('./package.json');
var child_process = require('child_process');
var proxy = require("./tcp-proxy.js");

argv
    .usage("[options]")
    .version(packageConfig.version)
    .option("-p, --proxyPort <number>",
        "Proxy port number (required for proxy mode)", parseInt)
    .option("-h, --hostname [name]", "Name or IP address of host for proxy listener")
    .option("-n, --serviceHost <name>",
        "Name or IP address of service host(s); " +
        "if this is a comma separated list (proxy mode), " +
        "performs round-robin load balancing (required)")
    .option("-s, --servicePort <number>", "Service port number(s); " +
        "if this a comma separated list (proxy mode)," +
        "it should have as many entries as serviceHost (required)")
    .option("-e, --exec <command_with_args>", "Execute command and pipe I/O (disables proxy mode)")
    .option("-m, --localAddress <address>",
        "IP address of interface to use to connect to service")
    .option("-l, --localPort <port>",
        "Port number to use to connect to service")
    .option("-q, --q", "Be quiet")
    .option("-t, --tls [both]", "Use TLS 1.2 with clients; " +
        "specify both to also use TLS 1.2 with service", false)
    .option("-u, --rejectUnauthorized [value]",
        "Do not accept invalid certificate", false)
    .option("-c, --pfx [file]", "Private key file",
        require.resolve("./cert.pfx"))
    .option("-a, --passphrase [value]",
        "Passphrase to access private key file", "abcd")
    .option("-i, --identUsers [user[,...]]",
        "Comma-separated list of authorized users", "")
    .option("-A, --allowedIPs [ip1[,...]]",
        "Comma-separated list of allowed IPs, overrides -i", "")
    .parse(process.argv);

var options = Object.assign(argv, {
    quiet: argv.q === true,
    tls: argv.tls,
    rejectUnauthorized: argv.rejectUnauthorized !== "false",
    identUsers: argv.identUsers === '' ? [] : argv.identUsers.split(','),
    allowedIps: argv.allowedIPs === '' ? [] : argv.allowedIPs.split(','),
    pfx: argv.pfx,
    passphrase: argv.passphrase
});

if (argv.exec) {
    if (argv.proxyPort) {
        console.error("Error: --proxyPort (-p) cannot be used with --exec (-e).");
        process.exit(1);
    }
    if (!argv.serviceHost || !argv.servicePort) {
        console.error("Error: --serviceHost (-n) and --servicePort (-s) are required for --exec (-e) mode.");
        argv.help();
    }
    if (argv.serviceHost.includes(',') || argv.servicePort.includes(',')) {
         console.warn("Warning: Load balancing is not supported in --exec mode. Only the first host/port will be used.");
         argv.serviceHost = argv.serviceHost.split(',')[0];
         argv.servicePort = argv.servicePort.toString().split(',')[0];
    }

    console.log(`Executing: ${argv.exec}`);
    console.log(`Connecting to: ${argv.serviceHost}:${argv.servicePort}`);

    const execControl = proxy.runCommandAndPipe(argv.serviceHost, argv.servicePort, argv.exec, options);

    process.on("SIGINT", function() {
        console.log("\nReceived SIGINT. Terminating command and closing connection.");
        const child = execControl.getChild();
        if (child && child.kill) {
            child.kill('SIGINT');
        }
        setTimeout(() => process.exit(0), 500);
    });

} else {
    if (!argv.proxyPort || !argv.serviceHost || !argv.servicePort) {
        console.error("Error: --proxyPort (-p), --serviceHost (-n), and --servicePort (-s) are required for proxy mode.");
        argv.help();
    }

    const proxyInstance = proxy.createProxy(argv.proxyPort,
        argv.serviceHost, argv.servicePort, options);

    process.on("uncaughtException", function(err) {
        console.error("Uncaught Exception:", err);
        proxyInstance.end();
    });

    process.on("SIGINT", function() {
        console.log("Received SIGINT. Shutting down proxy.");
        proxyInstance.end();
    });
}
