var net = require("net");
var tls = require('tls');
var fs = require('fs');
var util = require('util');
var child_process = require('child_process'); // Required for spawn

module.exports.createProxy = function(proxyPort,
    serviceHost, servicePort, options) {
    return new TcpProxy(proxyPort, serviceHost, servicePort, options);
};

// New function for executing a command and piping I/O over TCP/TLS
module.exports.runCommandAndPipe = function(serviceHost, servicePort, command, options) {
    const log = msg => { if (!options.quiet) { console.log(msg); } };
    let socket = null;
    let child = null;
    let retryTimeout = null;
    let isConnected = false;
    let userRequestedStop = false; // Flag to prevent retries after SIGINT

    const baseRetryInterval = 60 * 1000; // 60 seconds in milliseconds
    const jitterFactor = 0.20; // 20%

    const connectOptions = {
        host: serviceHost,
        port: parseInt(servicePort, 10),
        rejectUnauthorized: options.rejectUnauthorized
    };

    // Parse the command and arguments (only needs to be done once)
    const commandParts = command.match(/\$?"(?:\\.|[^"\\])*"|\S+/g) || [];
    const executable = commandParts[0];
    const args = commandParts.slice(1).map(arg => arg.replace(/^"(.*)"$/, '$1'));

    const cleanup = () => {
        if (socket) {
            socket.removeAllListeners(); // Prevent old listeners from firing
            socket.destroy();
            socket = null;
        }
        if (child && child.kill) {
            log('Terminating existing child process...');
            child.kill('SIGTERM'); // Try SIGTERM first
            // Consider a SIGKILL timeout if SIGTERM doesn't work
            child = null;
        }
        isConnected = false;
    };

    const scheduleRetry = (isInitialAttempt = false) => {
        cleanup();
        if (userRequestedStop) {
            log('Retry cancelled due to user request.');
            return;
        }

        const jitter = (Math.random() * 2 - 1) * jitterFactor * baseRetryInterval;
        const retryDelay = Math.max(0, baseRetryInterval + jitter); // Ensure delay is non-negative

        log(`Connection ${isInitialAttempt ? 'failed' : 'lost'}. Retrying in ${(retryDelay / 1000).toFixed(1)} seconds...`);
        clearTimeout(retryTimeout); // Clear any existing retry timeout
        retryTimeout = setTimeout(connect, retryDelay);
    };

    const connect = () => {
        if (userRequestedStop) return;
        log(`Attempting to connect to ${serviceHost}:${servicePort}...`);
        cleanup(); // Ensure clean state before connecting

        if (options.tls === 'both') {
            log('Connecting with TLS...');
            socket = tls.connect(connectOptions, onConnect);
        } else {
            log('Connecting with plain TCP...');
            socket = net.connect(connectOptions, onConnect);
        }

        socket.once('error', (err) => {
            log(`Connection error: ${err.message}`);
            // If we weren't connected yet, it's an initial failure
            // If we were connected, the 'close' event will likely handle the retry
            if (!isConnected) {
                scheduleRetry(true);
            }
        });

        // Use 'once' for close to avoid duplicate retries if error also fires close
        socket.once('close', () => {
            if (isConnected) {
                log('Connection closed.');
                isConnected = false;
                scheduleRetry(false);
            } else {
                // If close happens before 'connect' fired (e.g. immediate connection refused)
                // and error didn't schedule a retry, schedule one now.
                // Avoid scheduling if a retry is already pending
                if (!retryTimeout) {
                    log('Connection closed before establishing.');
                    scheduleRetry(true);
                }
            }
        });
    };

    const onConnect = () => {
        clearTimeout(retryTimeout); // Cancel any pending retry
        retryTimeout = null;
        isConnected = true;
        log('Successfully connected.');
        log(`Spawning command: ${executable} ${args.join(' ')}`);

        try {
            // Ensure previous child is gone before spawning new one
            if (child) {
                 log("Warning: Previous child process detected during reconnect. Attempting termination.");
                 child.kill('SIGKILL');
                 child = null;
            }

            child = child_process.spawn(executable, args, {
                shell: false
            });

            // Pipe socket -> child stdin
            socket.pipe(child.stdin);
            // Handle socket errors during piping
            socket.on('error', (err) => {
                log(`Socket error during pipe: ${err.message}`);
                // Connection will close, triggering retry via 'close' handler
            });

            // Pipe child stdout/stderr -> socket
            child.stdout.pipe(socket, { end: false }); // Don't end socket when stdout closes
            child.stderr.pipe(socket, { end: false }); // Don't end socket when stderr closes

            // Handle child process errors
            child.on('error', (err) => {
                log(`Subprocess error: ${err.message}`);
                // Don't necessarily schedule retry here, as the connection might still be good.
                // Let the socket closing trigger the retry if needed.
                // However, we should close the socket from our end if the child dies unexpectedly.
                if (socket && !socket.destroyed) {
                    socket.end(); // Signal end to remote side
                }
                child = null; // Mark child as gone
                // Schedule a retry as the process we need is gone.
                scheduleRetry(false);
            });

            child.on('exit', (code, signal) => {
                log(`Subprocess exited with code ${code}, signal ${signal}`);
                child = null; // Mark child as gone
                // If the exit was not due to our cleanup or user request, maybe retry.
                if (!userRequestedStop && socket && !socket.destroyed) {
                   log('Child process exited unexpectedly. Closing connection and scheduling retry.');
                   socket.end(); // Close the connection gracefully
                   // The socket 'close' event will trigger scheduleRetry
                } else if (socket && !socket.destroyed) {
                    // If exit was expected (e.g., SIGINT), just close the socket.
                    socket.end();
                }
            });

        } catch (spawnError) {
            log(`Error spawning command: ${spawnError.message}`);
            if (socket && !socket.destroyed) {
                socket.end();
            }
            // Spawning failed, treat as connection loss/failure
            scheduleRetry(false);
        }
    };

    connect(); // Start the initial connection attempt

    // Return an object with a method to stop the process and prevent retries
    return {
        stop: () => {
            log('Stopping execution and preventing further retries.');
            userRequestedStop = true;
            clearTimeout(retryTimeout);
            cleanup();
        }
    };
};

function uniqueKey(socket) {
    var key = socket.remoteAddress + ":" + socket.remotePort;
    return key;
}

function parse(o) {
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
    this.proxyPort = proxyPort;
    this.serviceHosts = parse(serviceHost);
    this.servicePorts = parse(servicePort);
    this.serviceHostIndex = -1;
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
    return Object.assign({
        quiet: true,
        pfx: require.resolve('./cert.pfx'),
        passphrase: 'abcd',
        rejectUnauthorized: true,
        identUsers: [],
        allowedIPs: []
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
        if (context.serviceSocket !== undefined) {
            context.serviceSocket.destroy();
        }
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
    return Object.assign({
        port: self.servicePorts[parseInt(i, 10)],
        host: self.serviceHosts[parseInt(i, 10)],
        localAddress: self.options.localAddress,
        localPort: self.options.localPort
    }, self.serviceTlsOptions);
};

TcpProxy.prototype.getServiceHostIndex = function(proxySocket) {
    this.serviceHostIndex++;
    if (this.serviceHostIndex == this.serviceHosts.length) {
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
