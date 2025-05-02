var net = require("net");
var tls = require('tls');
var fs = require('fs');
var util = require('util');
var child_process = require('child_process');

// Main entry point
module.exports.createProxy = function(proxyPort, serviceHost, servicePort, options) {
    options = parseCliOptions(options); // Use a helper to parse/validate options object itself

    if (options.executeCommand) {
        // Execute Mode: Act as a client, connect out, run command
        runExecuteClient(serviceHost, servicePort, options);
        return null; // Indicate no server/proxy object returned
    } else {
        // Proxy Mode: Act as a server, listen for connections
        return new TcpProxy(proxyPort, serviceHost, servicePort, options);
    }
};

// Helper to parse the options object passed from CLI
function parseCliOptions(options) {
    return Object.assign({
        quiet: true,
        pfx: require.resolve('./cert.pfx'),
        passphrase: 'abcd',
        rejectUnauthorized: true,
        identUsers: [],
        allowedIPs: [],
        executeCommand: null,
        tls: false, // Initialize tls option
        hostname: undefined, // Initialize hostname
        localAddress: undefined, // Initialize localAddress
        localPort: undefined // Initialize localPort
    }, options);
}

// Function to handle the execute client logic
function runExecuteClient(serviceHost, servicePort, options) {
    var log = options.quiet ? function() {} : console.log; // Simple logger based on quiet option
    log(`Connecting to ${serviceHost}:${servicePort} for command execution...`);

    var connectOptions = {
        host: serviceHost,
        port: servicePort,
        localAddress: options.localAddress,
        localPort: options.localPort
    };

    var clientSocket;
    var connectionFn = net.connect; // Default to net

    // Check if TLS should be used for the client connection
    if (options.tls === true || options.tls === 'both') { // Allow -t or -t both to enable TLS client
        log('Using TLS for client connection.');
        connectionFn = tls.connect;
        Object.assign(connectOptions, {
            rejectUnauthorized: options.rejectUnauthorized
            // Add client cert options if needed in the future
        });
    }

    clientSocket = connectionFn(connectOptions, function() {
        log('Connected to remote server. Spawning command...');
        spawnAndPipeCommand(clientSocket, options, log);
    });

    clientSocket.on('error', function(err) {
        log(`Client connection error: ${err}`);
        // Optional: attempt reconnect or just exit?
        process.exit(1); // Exit if connection fails
    });

    clientSocket.on('close', function() {
        log('Connection to remote server closed.');
        // Child process should be killed by its own handler when socket closes
    });
}

// Function to spawn the command and set up piping (used by execute client)
function spawnAndPipeCommand(socket, options, log) {
    var commandParts = options.executeCommand.split(/s+/);
    var command = commandParts[0];
    var args = commandParts.slice(1);

    log(`Executing command: ${command} ${args.join(' ')}`);

    var child = child_process.spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    // Pipe socket <-> process stdio
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    child.stderr.pipe(socket);

    child.on('close', function(code) {
        log(`Command exited with code: ${code}`);
        socket.end(); // Close the socket when the process exits
    });

    child.on('error', function(err) {
        log(`Failed to start command: ${err}`);
        socket.end(`Error executing command: ${err.message}\n`);
    });

    // Handle socket close/error: kill the process
    socket.on('close', function() {
        log('Remote connection closed, terminating command.');
        child.kill();
    });
    socket.on('error', function(err) {
        log(`Socket error: ${err}. Terminating command.`);
        child.kill();
    });
}

function uniqueKey(socket) {
    var key = socket.remoteAddress + ":" + socket.remotePort;
    return key;
}

function parse(o) {
    console.log("parse: ", o)
    if (typeof o === "string") {
        return o.split(",");
    } else if (typeof o === "number") {
        return parse(o.toString());
    } else if (Array.isArray(o)) {
        return o;
    } else {
        throw new Error("cannot parse object: " + o);
    }
}

function TcpProxy(proxyPort, serviceHost, servicePort, options) {
    console.log("options: ", options);
    this.proxyPort = proxyPort;
    if (!options.executeCommand) {
        this.serviceHosts = parse(serviceHost);
        this.servicePorts = parse(servicePort);
        this.serviceHostIndex = -1;
    } else {
        this.serviceHosts = [];
        this.servicePorts = [];
        this.serviceHostIndex = -1;
    }
    this.options = this.parseOptions(options);
    this.proxyTlsOptions = {
        passphrase: this.options.passphrase,
        secureProtocol: "TLSv1_2_method"
    };
    if (this.options.tls) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        this.proxyTlsOptions.pfx = fs.readFileSync(this.options.pfx);
    }
    this.serviceTlsOptions = {
        rejectUnauthorized: this.options.rejectUnauthorized,
        secureProtocol: "TLSv1_2_method"
    };
    this.proxySockets = {};
    if (this.options.identUsers.length !== 0) {
        this.users = this.options.identUsers;
        this.log('Will only allow these users: '.concat(this.users.join(', ')));
    } else {
        this.log('Will allow all users');
    }
    if (this.options.allowedIPs.length !== 0) {
        this.allowedIPs = this.options.allowedIPs;
    }
    this.createListener();
}

TcpProxy.prototype.parseOptions = function(options) {
    // This is now handled by parseCliOptions at the entry point
    // Keep this method for now in case it's used internally, but ensure defaults match
    return Object.assign({
        quiet: true,
        pfx: require.resolve('./cert.pfx'),
        passphrase: 'abcd',
        rejectUnauthorized: true,
        identUsers: [],
        allowedIPs: [],
        executeCommand: null,
        tls: false,
        hostname: undefined,
        localAddress: undefined,
        localPort: undefined
    }, options);
};

TcpProxy.prototype.createListener = function() {
    var self = this;
    if (self.options.tls) {
        self.server = tls.createServer(self.options.customTlsOptions || self.proxyTlsOptions, function(socket) {
            self.handleClientConnection(socket);
        });
    } else {
        self.server = net.createServer(function(socket) {
            self.handleClientConnection(socket);
        });
    }
    self.server.listen(self.proxyPort, self.options.hostname);
};

TcpProxy.prototype.handleClientConnection = function(socket) {
    var self = this;
    if (self.users) {
        self.handleAuth(socket);
    } else {
        self.handleClient(socket);
    }
};

// RFC 1413 authentication
TcpProxy.prototype.handleAuth = function(proxySocket) {
    var self = this;
    if (self.allowedIPs.includes(proxySocket.remoteAddress)) {
        self.handleClient(proxySocket);
        return;
    }
    var query = util.format("%d, %d", proxySocket.remotePort, this.proxyPort);
    var ident = new net.Socket();
    var resp = undefined;
    ident.on('error', function(e) {
        resp = false;
        ident.destroy();
    });
    ident.on('data', function(data) {
        resp = data.toString().trim();
        ident.destroy();
    });
    ident.on('close', function(data) {
        if (!resp) {
            self.log('No identd');
            proxySocket.destroy();
            return;
        }
        var user = resp.split(':').pop();
        if (!self.users.includes(user)) {
            self.log(util.format('User "%s" unauthorized', user));
            proxySocket.destroy();
        } else {
            self.handleClient(proxySocket);
        }
    });
    ident.connect(113, proxySocket.remoteAddress, function() {
        ident.write(query);
        ident.end();
    });
};

TcpProxy.prototype.handleClient = function(proxySocket) {
    
    var self = this;
    var key = uniqueKey(proxySocket);
    self.proxySockets[`${key}`] = proxySocket;
    if (self.options.executeCommand) {
        self.handleExecution(proxySocket);
    } else {
        var context = {
            buffers: [],
            connected: false,
            proxySocket: proxySocket
        };
        proxySocket.on("data", function(data) {
            self.handleUpstreamData(context, data);
        });
        proxySocket.on("close", function(hadError) {
            delete self.proxySockets[uniqueKey(proxySocket)];
            if (context.serviceSocket !== undefined) {
                context.serviceSocket.destroy();
            }
        });
        proxySocket.on("error", function(e) {
            self.log("Proxy socket error: " + e);
            if (context.serviceSocket !== undefined) {
                context.serviceSocket.destroy();
            }
            proxySocket.destroy();
        });
    }
};

TcpProxy.prototype.handleExecution = function(proxySocket) {
    var self = this;
    var commandParts = self.options.executeCommand.split(/s+/);
    var command = commandParts[0];
    var args = commandParts.slice(1);

    self.log(`Executing command: ${command} ${args.join(' ')}`);

    var child = child_process.spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    proxySocket.pipe(child.stdin);

    child.stdout.pipe(proxySocket);
    child.stderr.pipe(proxySocket);

    child.on('close', function(code) {
        self.log(`Command exited with code: ${code}`);
        proxySocket.end();
    });

    child.on('error', function(err) {
        self.log(`Failed to start command: ${err}`);
        proxySocket.end(`Error executing command: ${err.message}\n`);
    });

    proxySocket.on('close', function() {
        self.log('Client disconnected, terminating command.');
        child.kill();
        delete self.proxySockets[uniqueKey(proxySocket)];
    });

    proxySocket.on("error", function(e) {
        self.log("Proxy socket error: " + e);
        child.kill();
        delete self.proxySockets[uniqueKey(proxySocket)];
        proxySocket.destroy();
    });
};

TcpProxy.prototype.handleUpstreamData = function(context, data) {
    var self = this;
    Promise.resolve(self.intercept(self.options.upstream, context, data))
        .then((processedData) => {
            if (context.connected) {
                context.serviceSocket.write(processedData);
            } else {
                context.buffers[context.buffers.length] = processedData;
                if (context.serviceSocket === undefined) {
                    self.createServiceSocket(context);
                }
            }
        });
};

TcpProxy.prototype.createServiceSocket = function(context) {
    var self = this;
    var options = self.parseServiceOptions(context);
    if (!self.options.executeCommand && (self.serviceHosts.length === 0 || self.servicePorts.length === 0)) {
        self.log("Error: Service host/port configuration is missing or invalid.");
        context.proxySocket.destroy();
        return;
    }
    if (self.options.tls === "both") {
        context.serviceSocket = tls.connect(options, function() {
            self.writeBuffer(context);
        });
    } else {
        context.serviceSocket = new net.Socket();
        context.serviceSocket.connect(options, function() {
            self.writeBuffer(context);
        });
    }
    context.serviceSocket.on("data", function(data) {
        Promise.resolve(self.intercept(self.options.downstream, context, data))
            .then((processedData) => context.proxySocket.write(processedData));
    });
    context.serviceSocket.on("close", function(hadError) {
        if (context.proxySocket !== undefined) {
            context.proxySocket.destroy();
        }
    });
    context.serviceSocket.on("error", function(e) {
        if (context.proxySocket !== undefined) {
            context.proxySocket.destroy();
        }
    });
};

TcpProxy.prototype.parseServiceOptions = function(context) {
    var self = this;
    var i = self.getServiceHostIndex(context.proxySocket);
    if (i < 0 || i >= self.serviceHosts.length || i >= self.servicePorts.length) {
        self.log(`Error: Invalid service host index ${i} for hosts/ports.`);
        context.proxySocket.destroy();
        return null;
    }
    return Object.assign({
        port: self.servicePorts[parseInt(i, 10)],
        host: self.serviceHosts[parseInt(i, 10)],
        localAddress: self.options.localAddress,
        localPort: self.options.localPort
    }, self.serviceTlsOptions);
};

TcpProxy.prototype.getServiceHostIndex = function(proxySocket) {
    if (this.options.executeCommand || !this.serviceHosts || this.serviceHosts.length === 0) {
        return -1;
    }
    this.serviceHostIndex++;
    if (this.serviceHostIndex >= this.serviceHosts.length) {
        this.serviceHostIndex = 0;
    }
    var index = this.serviceHostIndex;
    if (this.options.serviceHostSelected) {
        index = this.options.serviceHostSelected(proxySocket, index);
    }
    return index;
};

TcpProxy.prototype.writeBuffer = function(context) {
    context.connected = true;
    if (context.buffers.length > 0) {
        for (var i = 0; i < context.buffers.length; i++) {
            context.serviceSocket.write(context.buffers[parseInt(i, 10)]);
        }
    }
};

TcpProxy.prototype.end = function() {
    this.server.close();
    for (var key in this.proxySockets) {
        this.proxySockets[`${key}`].destroy();
    }
    this.server.unref();
};

TcpProxy.prototype.log = function(msg) {
    if (!this.options.quiet) {
        console.log(msg);
    }
};

TcpProxy.prototype.intercept = function(interceptor, context, data) {
    if (interceptor) {
        return interceptor(context, data);
    }
    return data;
};
