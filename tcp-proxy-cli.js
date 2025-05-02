#!/usr/bin/env node
var argv = require("commander");
var packageConfig = require('./package.json');

argv
    .usage("[options]")
    .version(packageConfig.version)
    .option("-p, --proxyPort <number>",
        "Proxy listener port number (required for proxy mode)", parseInt)
    .option("-h, --hostname [name]", "Name or IP address of host (for proxy listener)")
    .option("-n, --serviceHost <name>",
        "Target host name or IP address; " +
        "if proxy mode and comma separated, performs round-robin; " +
        "required otherwise.")
    .option("-s, --servicePort <number>", "Target port number; " +
        "if proxy mode and comma separated, corresponds to serviceHost; " +
        "required otherwise.")
    .option("-e, --execute <command>", "Command to execute locally and pipe over connection (alternative to proxy mode)")
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
    rejectUnauthorized: argv.rejectUnauthorized !== "false",
    identUsers: argv.identUsers === '' ? [] : argv.identUsers.split(','),
    allowedIps: argv.allowedIPs === '' ? [] : argv.allowedIPs.split(','),
    executeCommand: argv.execute
});

if (argv.execute) {
    if (!argv.serviceHost || !argv.servicePort) {
        console.error("Error: --execute mode requires --serviceHost (-n) and --servicePort (-s).");
        argv.help();
        process.exit(1);
    }
} else {
    if (!argv.proxyPort || !argv.serviceHost || !argv.servicePort) {
        console.error("Error: Proxy mode requires --proxyPort (-p), --serviceHost (-n), and --servicePort (-s).");
        argv.help();
        process.exit(1);
    }
}

var instance = require("./tcp-proxy.js").createProxy(argv.proxyPort, argv.serviceHost, argv.servicePort, options);

process.on("uncaughtException", function(err) {
    console.error(err);
    if (instance && typeof instance.end === 'function') { instance.end(); }
});

process.on("SIGINT", function() {
    if (instance && typeof instance.end === 'function') { instance.end(); }
});
