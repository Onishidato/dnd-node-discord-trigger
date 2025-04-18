import ipc from 'node-ipc';
import { INodePropertyOptions } from 'n8n-workflow';
import axios from "axios";
import { getCredentialHash } from './settings';

// Add type declaration for the global property
declare global {
    var __n8nDiscordSocketPath: string;
    var __n8nDiscordIPCInitialized: boolean;
}

export interface ICredentials {
    clientId: string;
    token: string;
    apiKey: string;
    baseUrl: string;
}

// Helper function to get a consistent socket path that matches the server
function getSocketPath() {
    // If the global path was set by bot.ts, use that to ensure consistency
    if (global.__n8nDiscordSocketPath) {
        return global.__n8nDiscordSocketPath;
    }

    // Check if we're on Windows
    const isWindows = process.platform === 'win32';

    if (isWindows) {
        // Use Windows-compatible path (named pipe)
        return '\\\\.\\pipe\\n8n-discord-bot';
    } else {
        // Use Unix socket path
        return '/tmp/bot';
    }
}

// Initialize IPC configuration once to prevent duplicate setup
function initializeIPC() {
    if (global.__n8nDiscordIPCInitialized) {
        return;
    }

    // Check if we're on Windows
    const isWindows = process.platform === 'win32';

    // Configure IPC based on platform
    ipc.config.id = 'discord-bot-client';
    ipc.config.retry = 1500;
    ipc.config.silent = false; // Enable logs for debugging
    ipc.config.maxRetries = 10;
    ipc.config.stopRetrying = false;

    if (isWindows) {
        // Windows-specific configuration
        ipc.config.networkHost = 'localhost';
        ipc.config.networkPort = 8000;
        ipc.config.socketRoot = '';  // Not used on Windows
    } else {
        // Unix-specific configuration
        ipc.config.socketRoot = '/tmp/';
        ipc.config.appspace = '';
        ipc.config.unlink = true;    // Clean up socket on exit
    }

    // Mark as initialized
    global.__n8nDiscordIPCInitialized = true;
    console.log('IPC configuration initialized for ' + (isWindows ? 'Windows' : 'Unix') + ' platform');
}

// Maintain a cache of active connections to avoid creating multiple connections to the same server
const connectionCache: {[key: string]: boolean} = {};

export const connection = (credentials: ICredentials): Promise<string> => {
    return new Promise((resolve, reject) => {
        // Validate credentials
        if (!credentials || !credentials.token || !credentials.clientId) {
            return reject(new Error('Missing required credentials (token or clientId)'));
        }

        // Initialize IPC configuration
        initializeIPC();

        // Generate a credential hash for this connection
        const credHash = getCredentialHash(credentials.clientId, credentials.token);

        // Get platform-specific socket path
        const socketPath = getSocketPath();
        const isWindows = process.platform === 'win32';

        console.log(`IPC Client Configuration: Platform: ${isWindows ? 'Windows' : 'Unix'}, Socket Path: ${socketPath}`);
        console.log(`Attempting connection for credentials with clientId: ${credentials.clientId.substring(0, 5)}... (hash: ${credHash.substring(0, 8)})`);

        // Set timeout for connection attempt - increase from 15s to 30s to allow more time for connection
        const timeout = setTimeout(() => {
            console.error('Connection timed out - checking if Discord bot server is running...');
            reject(new Error(`Connection timeout after 30 seconds. Please ensure the Discord bot server is running at ${socketPath}`));
        }, 30000);

        // Check if we already have an active connection
        if (connectionCache[credHash]) {
            clearTimeout(timeout);
            console.log(`Using existing connection for credential hash: ${credHash}`);
            return resolve('already');
        }

        // Use a unique connection ID to avoid conflicts with multiple bots
        const connectionId = `bot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        try {
            ipc.connectTo(connectionId, socketPath, () => {
                console.log(`Attempting to connect to IPC server at: ${socketPath} with connection ID: ${connectionId}`);

                // Handle connection error
                ipc.of[connectionId].on('error', (err: any) => {
                    console.error(`IPC connection error for ${connectionId}:`, err);
                    connectionCache[credHash] = false;
                    clearTimeout(timeout);

                    if (isWindows && err.code === 'ENOENT') {
                        reject(new Error(`IPC server not found at ${socketPath}. Ensure Discord bot is running on Windows.`));
                    } else {
                        reject(new Error(`IPC error: ${err.message || 'Unknown error'}`));
                    }

                    // Clean up this connection attempt
                    try {
                        ipc.disconnect(connectionId);
                    } catch (e) {
                        console.error(`Error disconnecting from ${connectionId}:`, e);
                    }
                });

                ipc.of[connectionId].on('connect', () => {
                    console.log(`Successfully connected to IPC server with connection ID: ${connectionId}`);
                    // Mark connection as active in cache
                    connectionCache[credHash] = true;
                    // Send credentials along with the credential hash
                    ipc.of[connectionId].emit('credentials', { credentials, credentialHash: credHash });
                });

                ipc.of[connectionId].on('credentials', (data: string) => {
                    clearTimeout(timeout);

                    // Clean up this connection as we've received a response
                    setTimeout(() => {
                        try {
                            ipc.disconnect(connectionId);
                            console.log(`Disconnected from ${connectionId} after receiving credentials response`);
                        } catch (e) {
                            console.error(`Error disconnecting from ${connectionId}:`, e);
                        }
                    }, 1000);

                    if (data === 'error') {
                        connectionCache[credHash] = false;
                        reject(new Error('Invalid credentials'));
                    } else if (data === 'missing') {
                        connectionCache[credHash] = false;
                        reject(new Error('Token or clientId missing'));
                    } else if (data === 'login') {
                        reject(new Error('Already logging in'));
                    } else if (data === 'different') {
                        resolve('Already logging in with different credentials');
                    } else {
                        resolve(data); // ready / already
                    }
                });

                ipc.of[connectionId].on('disconnect', () => {
                    console.log(`IPC connection disconnected for ${connectionId} (cred hash: ${credHash})`);
                });
            });
        } catch (error) {
            clearTimeout(timeout);
            console.error('Error establishing IPC connection:', error);
            reject(new Error(`Failed to establish IPC connection: ${error.message}`));
        }
    });
};


// Helper function to create a reusable IPC connection
function createIPCConnection(credentialHash: string): Promise<any> {
    return new Promise((resolve, reject) => {
        // Initialize IPC configuration
        initializeIPC();

        const socketPath = getSocketPath();
        const isWindows = process.platform === 'win32';

        // Use a unique connection ID for each request
        const connectionId = `bot_req_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        console.log(`Creating IPC connection: Platform: ${isWindows ? 'Windows' : 'Unix'}, Socket Path: ${socketPath}, Connection ID: ${connectionId}`);

        // Set a timeout to prevent hanging indefinitely
        const connectionTimeout = setTimeout(() => {
            console.error(`IPC connection timed out for request with credential hash ${credentialHash} (${connectionId})`);
            try {
                ipc.disconnect(connectionId);
            } catch (e) {
                console.error(`Error disconnecting timed out connection ${connectionId}:`, e);
            }
            resolve(null);
        }, 10000);

        try {
            // Connect with the unique ID
            ipc.connectTo(connectionId, socketPath, () => {
                ipc.of[connectionId].on('connect', function() {
                    clearTimeout(connectionTimeout);
                    console.log(`IPC connection established for request with credential hash ${credentialHash} (${connectionId})`);
                    resolve(ipc.of[connectionId]);
                });

                ipc.of[connectionId].on('error', function(err: any) {
                    clearTimeout(connectionTimeout);
                    console.error(`IPC connection error in helper function (${connectionId}):`, err);

                    if (isWindows && err.code === 'ENOENT') {
                        console.error(`Named pipe not found at ${socketPath}. Ensure Discord bot is running on Windows.`);
                    }

                    try {
                        ipc.disconnect(connectionId);
                    } catch (e) {
                        console.error(`Error disconnecting from ${connectionId} after error:`, e);
                    }

                    resolve(null);
                });
            });
        } catch (error) {
            clearTimeout(connectionTimeout);
            console.error(`Error creating IPC connection (${connectionId}):`, error);

            try {
                ipc.disconnect(connectionId);
            } catch (e) {
                console.error(`Error disconnecting from ${connectionId} after connection creation error:`, e);
            }

            resolve(null);
        }
    });
}

export const getChannels = async (that: any, guildIds: string[]): Promise<INodePropertyOptions[]> => {
    const endMessage = ' - Close and reopen this node modal once you have made changes.';

    try {
        const credentials = await that.getCredentials('discordBotTriggerApi');
        const res = await connection(credentials);

        if (!['ready', 'already'].includes(res)) {
            throw new Error(`Connection failed: ${res}`);
        }

        // Calculate credential hash for this request
        const credHash = getCredentialHash(credentials.clientId, credentials.token);

        const channelsRequest = () =>
            new Promise<any>(async (resolve) => {
                const timeout = setTimeout(() => {
                    resolve([]);
                }, 5000);

                let ipcClient: any = null;
                try {
                    // Get IPC connection
                    ipcClient = await createIPCConnection(credHash);

                    if (!ipcClient) {
                        clearTimeout(timeout);
                        return resolve([]);
                    }

                    // Set up event listener for response
                    const responseHandler = (data: { name: string; value: string }[]) => {
                        clearTimeout(timeout);
                        ipcClient.off('list:channels', responseHandler);

                        // Disconnect after receiving response
                        try {
                            const connId = ipcClient.id || 'unknown';
                            ipc.disconnect(connId);
                            console.log(`Disconnected from ${connId} after channels response`);
                        } catch (e) {
                            console.error(`Error disconnecting after channels response:`, e);
                        }

                        resolve(data);
                    };

                    ipcClient.on('list:channels', responseHandler);

                    // Send the request
                    ipcClient.emit('list:channels', {
                        guildIds,
                        credentialHash: credHash
                    });
                } catch (error) {
                    console.error('Error in channels request:', error);
                    clearTimeout(timeout);

                    // Ensure disconnection on error
                    if (ipcClient) {
                        try {
                            const connId = ipcClient.id || 'unknown';
                            ipc.disconnect(connId);
                        } catch (e) {
                            console.error(`Error disconnecting after channels error:`, e);
                        }
                    }

                    resolve([]);
                }
            });

        const channels = await channelsRequest();

        if (Array.isArray(channels) && channels.length) {
            return channels;
        } else {
            return [{
                name: 'Your Discord server has no text channels, please add at least one text channel' + endMessage,
                value: 'false',
            }];
        }
    } catch (error) {
        console.error('Error getting channels:', error);
        return [{
            name: `Error: ${error.message}` + endMessage,
            value: 'false',
        }];
    }
};


export const getGuilds = async (that: any): Promise<INodePropertyOptions[]> => {
    const endMessage = ' - Close and reopen this node modal once you have made changes.';

    try {
        const credentials = await that.getCredentials('discordBotTriggerApi');
        const res = await connection(credentials);

        if (!['ready', 'already'].includes(res)) {
            throw new Error(`Connection failed: ${res}`);
        }

        // Calculate credential hash for this request
        const credHash = getCredentialHash(credentials.clientId, credentials.token);

        const guildsRequest = () =>
            new Promise<any>(async (resolve) => {
                const timeout = setTimeout(() => {
                    resolve([]);
                }, 5000);

                let ipcClient: any = null;
                try {
                    // Get IPC connection
                    ipcClient = await createIPCConnection(credHash);

                    if (!ipcClient) {
                        clearTimeout(timeout);
                        return resolve([]);
                    }

                    // Set up event listener for response
                    const responseHandler = (data: { name: string; value: string }[]) => {
                        clearTimeout(timeout);
                        ipcClient.off('list:guilds', responseHandler);

                        // Disconnect after receiving response
                        try {
                            const connId = ipcClient.id || 'unknown';
                            ipc.disconnect(connId);
                            console.log(`Disconnected from ${connId} after guilds response`);
                        } catch (e) {
                            console.error(`Error disconnecting after guilds response:`, e);
                        }

                        resolve(data);
                    };

                    ipcClient.on('list:guilds', responseHandler);

                    // Send the request
                    ipcClient.emit('list:guilds', {
                        credentialHash: credHash
                    });
                } catch (error) {
                    console.error('Error in guilds request:', error);
                    clearTimeout(timeout);

                    // Ensure disconnection on error
                    if (ipcClient) {
                        try {
                            const connId = ipcClient.id || 'unknown';
                            ipc.disconnect(connId);
                        } catch (e) {
                            console.error(`Error disconnecting after guilds error:`, e);
                        }
                    }

                    resolve([]);
                }
            });

        const guilds = await guildsRequest();

        if (Array.isArray(guilds) && guilds.length) {
            return guilds;
        } else {
            return [{
                name: 'Your bot is not part of any guilds. Please add the bot to at least one guild.' + endMessage,
                value: 'false',
            }];
        }
    } catch (error) {
        console.error('Error getting guilds:', error);
        return [{
            name: `Error: ${error.message}` + endMessage,
            value: 'false',
        }];
    }
};

export interface IRole {
    name: string;
    id: string;
}

export const getRoles = async (that: any, selectedGuildIds: string[]): Promise<INodePropertyOptions[]> => {
    const endMessage = ' - Close and reopen this node modal once you have made changes.';

    try {
        // Check if any guilds are selected
        if (!selectedGuildIds || selectedGuildIds.length === 0) {
            // Return a helpful message instead of throwing an error
            return [{
                name: 'Please select at least one server first to see available roles' + endMessage,
                value: 'false',
            }];
        }

        const credentials = await that.getCredentials('discordBotTriggerApi');
        const res = await connection(credentials);

        if (!['ready', 'already'].includes(res)) {
            throw new Error(`Connection failed: ${res}`);
        }

        // Calculate credential hash for this request
        const credHash = getCredentialHash(credentials.clientId, credentials.token);

        const rolesRequest = () =>
            new Promise<any>(async (resolve) => {
                const timeout = setTimeout(() => {
                    resolve([]);
                }, 5000);

                let ipcClient: any = null;
                try {
                    // Get IPC connection
                    ipcClient = await createIPCConnection(credHash);

                    if (!ipcClient) {
                        clearTimeout(timeout);
                        return resolve([]);
                    }

                    // Set up event listener for response
                    const responseHandler = (data: any) => {
                        clearTimeout(timeout);
                        ipcClient.off('list:roles', responseHandler);

                        // Disconnect after receiving response
                        try {
                            const connId = ipcClient.id || 'unknown';
                            ipc.disconnect(connId);
                            console.log(`Disconnected from ${connId} after roles response`);
                        } catch (e) {
                            console.error(`Error disconnecting after roles response:`, e);
                        }

                        resolve(data);
                    };

                    ipcClient.on('list:roles', responseHandler);

                    // Send the request
                    ipcClient.emit('list:roles', {
                        guildIds: selectedGuildIds,
                        credentialHash: credHash
                    });
                } catch (error) {
                    console.error('Error in roles request:', error);
                    clearTimeout(timeout);

                    // Ensure disconnection on error
                    if (ipcClient) {
                        try {
                            const connId = ipcClient.id || 'unknown';
                            ipc.disconnect(connId);
                        } catch (e) {
                            console.error(`Error disconnecting after roles error:`, e);
                        }
                    }

                    resolve([]);
                }
            });

        const roles = await rolesRequest();

        if (Array.isArray(roles)) {
            const filtered = roles.filter((r: any) => r.name !== '@everyone');
            if (filtered.length) {
                return filtered;
            } else {
                return [{
                    name: 'Your Discord server has no roles, please add at least one if you want to restrict the trigger to specific users' + endMessage,
                    value: 'false',
                }];
            }
        } else {
            throw new Error('Something went wrong');
        }
    } catch (error) {
        console.error('Error getting roles:', error);
        return [{
            name: `Error: ${error.message}` + endMessage,
            value: 'false',
        }];
    }
};


export const checkWorkflowStatus = async (n8nApiUrl: String, apiToken: String, workflowId: String): Promise<boolean> => {
    const apiUrl = `${removeTrailingSlash(n8nApiUrl)}/workflows/${workflowId}`;
    try {
        const response = await axios.get(apiUrl, {
            headers: {
                'X-N8N-API-KEY': `${apiToken}`,
            },
        });
        // return if workflow is active or not
        return response.data.active;
    } catch (error) {
        console.error('Error checking workflow status:', error.message);
        throw new Error(`Workflow status check failed: ${error.message}`);
    }
}

export const ipcRequest = async (type: string, parameters: any, credentials: ICredentials): Promise<any> => {
    try {
        // Calculate credential hash
        const credHash = getCredentialHash(credentials.clientId, credentials.token);

        // Initialize IPC configuration
        initializeIPC();

        return new Promise(async (resolve) => {
            const timeout = setTimeout(() => {
                console.log(`Request ${type} timed out after 10 seconds`);
                resolve(null);
            }, 10000);

            let ipcClient: any = null;
            try {
                // Get IPC connection with a unique ID
                ipcClient = await createIPCConnection(credHash);

                if (!ipcClient) {
                    clearTimeout(timeout);
                    return resolve(null);
                }

                // Set up response handler
                const responseHandler = (data: any) => {
                    clearTimeout(timeout);
                    // Remove the listener to prevent memory leaks
                    ipcClient.off(`callback:${type}`, responseHandler);

                    // Disconnect after receiving response
                    try {
                        const connId = ipcClient.id || 'unknown';
                        ipc.disconnect(connId);
                        console.log(`Disconnected from ${connId} after ${type} response`);
                    } catch (e) {
                        console.error(`Error disconnecting after ${type} response:`, e);
                    }

                    resolve(data);
                };

                ipcClient.on(`callback:${type}`, responseHandler);

                // Add a timeout handler to ensure connection gets cleaned up
                const connectionTimeout = setTimeout(() => {
                    try {
                        if (ipcClient) {
                            const connId = ipcClient.id || 'unknown';
                            ipc.disconnect(connId);
                            console.log(`Force disconnected from ${connId} due to no response for ${type}`);
                        }
                    } catch (e) {
                        console.error(`Error force disconnecting:`, e);
                    }
                }, 12000); // Slightly longer than the response timeout

                // Send the request
                ipcClient.emit(type, {
                    nodeParameters: parameters,
                    credentialHash: credHash
                });

                // Clear the connection timeout when response timeout is cleared
                timeout.unref();
                connectionTimeout.unref();
            } catch (error) {
                console.error(`Error in ${type} request:`, error);
                clearTimeout(timeout);

                // Ensure disconnection on error
                if (ipcClient) {
                    try {
                        const connId = ipcClient.id || 'unknown';
                        ipc.disconnect(connId);
                    } catch (e) {
                        console.error(`Error disconnecting after ${type} error:`, e);
                    }
                }

                resolve(null);
            }
        });
    } catch (error) {
        console.error(`Error in ipcRequest (${type}):`, error);
        return null;
    }
};

// Helper function to clean up bot connection for a specific node
export const cleanupBot = async (nodeId: string, credentials: ICredentials): Promise<boolean> => {
    try {
        // Calculate credential hash
        const credHash = getCredentialHash(credentials.clientId, credentials.token);

        // Initialize IPC configuration
        initializeIPC();

        // Use a unique connection ID for cleanup
        const cleanupConnectionId = `cleanup_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        return new Promise(async (resolve) => {
            const timeout = setTimeout(() => {
                console.log(`Cleanup request timed out after 5 seconds`);
                // Clean up connection from cache even if timeout occurs
                delete connectionCache[credHash];

                try {
                    ipc.disconnect(cleanupConnectionId);
                } catch (e) {
                    console.error(`Error disconnecting timed out cleanup connection:`, e);
                }

                resolve(false);
            }, 5000);

            try {
                // Create a new connection with the unique ID
                const socketPath = getSocketPath();
                let connected = false;

                ipc.connectTo(cleanupConnectionId, socketPath, () => {
                    ipc.of[cleanupConnectionId].on('connect', () => {
                        connected = true;
                        console.log(`Cleanup connection established for ${nodeId} (${cleanupConnectionId})`);

                        // Set up response handler for cleanup response
                        ipc.of[cleanupConnectionId].on('cleanupBot:response', (data: any) => {
                            clearTimeout(timeout);
                            // Clean up this connection from the cache
                            delete connectionCache[credHash];

                            // Disconnect this IPC connection
                            try {
                                ipc.disconnect(cleanupConnectionId);
                                console.log(`Disconnected cleanup connection ${cleanupConnectionId}`);
                            } catch (err) {
                                console.error(`Error disconnecting cleanup IPC connection:`, err);
                            }

                            resolve(data.success);
                        });

                        // Send the cleanup request
                        ipc.of[cleanupConnectionId].emit('cleanupBot', {
                            nodeId,
                            credentialHash: credHash
                        });
                    });

                    // Handle connection errors
                    ipc.of[cleanupConnectionId].on('error', (err: any) => {
                        console.error(`Error in cleanup connection (${cleanupConnectionId}):`, err);
                        if (!connected) {
                            clearTimeout(timeout);

                            try {
                                ipc.disconnect(cleanupConnectionId);
                            } catch (e) {
                                console.error(`Error disconnecting errored cleanup connection:`, e);
                            }

                            resolve(false);
                        }
                    });
                });
            } catch (error) {
                console.error('Error in cleanupBot request:', error);
                clearTimeout(timeout);

                try {
                    ipc.disconnect(cleanupConnectionId);
                } catch (e) {
                    console.error(`Error disconnecting failed cleanup connection:`, e);
                }

                resolve(false);
            }
        });
    } catch (error) {
        console.error('Error in cleanupBot:', error);
        return false;
    }
};


// Helper function to detect MIME type from filename
export const detectMimeTypeFromFilename = (filename?: string): string => {
    if (!filename) return 'application/octet-stream';

    const extension = filename.split('.').pop()?.toLowerCase() || '';

    const mimeTypeMap: Record<string, string> = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'bmp': 'image/bmp',
        'tiff': 'image/tiff',
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'txt': 'text/plain',
        'csv': 'text/csv',
        'html': 'text/html',
        'js': 'text/javascript',
        'json': 'application/json',
        'xml': 'application/xml',
        'zip': 'application/zip',
        'mp3': 'audio/mpeg',
        'mp4': 'video/mp4',
        'wav': 'audio/wav',
        'avi': 'video/x-msvideo',
        'mov': 'video/quicktime'
    };

    return mimeTypeMap[extension] || 'application/octet-stream';
};

function removeTrailingSlash(url: String) {
    if (url.endsWith('/')) {
        return url.slice(0, -1);
    }
    return url;
}
