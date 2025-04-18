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

        try {
            ipc.connectTo('bot', socketPath, () => {
                console.log('Attempting to connect to IPC server at:', socketPath);

                // Handle connection error
                ipc.of.bot.on('error', (err: any) => {
                    console.error('IPC connection error:', err);
                    connectionCache[credHash] = false;
                    clearTimeout(timeout);

                    if (isWindows && err.code === 'ENOENT') {
                        reject(new Error(`IPC server not found at ${socketPath}. Ensure Discord bot is running on Windows.`));
                    } else {
                        reject(new Error(`IPC error: ${err.message || 'Unknown error'}`));
                    }
                });

                ipc.of.bot.on('connect', () => {
                    console.log('Successfully connected to IPC server');
                    // Mark connection as active in cache
                    connectionCache[credHash] = true;
                    // Send credentials along with the credential hash
                    ipc.of.bot.emit('credentials', { credentials, credentialHash: credHash });
                });

                ipc.of.bot.on('credentials', (data: string) => {
                    clearTimeout(timeout);

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

                ipc.of.bot.on('disconnect', () => {
                    console.log(`IPC connection disconnected for ${credHash}`);
                    connectionCache[credHash] = false;
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

        console.log(`Creating IPC connection: Platform: ${isWindows ? 'Windows' : 'Unix'}, Socket Path: ${socketPath}`);

        // Set a timeout to prevent hanging indefinitely
        const connectionTimeout = setTimeout(() => {
            console.error(`IPC connection timed out for request with credential hash ${credentialHash}`);
            resolve(null);
        }, 10000);

        try {
            // No need to re-configure IPC here since we've initialized it already
            ipc.connectTo('bot', socketPath, () => {
                ipc.of.bot.on('connect', function() {
                    clearTimeout(connectionTimeout);
                    console.log(`IPC connection established for request with credential hash ${credentialHash}`);
                    resolve(ipc.of.bot);
                });

                ipc.of.bot.on('error', function(err: any) {
                    clearTimeout(connectionTimeout);
                    console.error('IPC connection error in helper function:', err);

                    if (isWindows && err.code === 'ENOENT') {
                        console.error(`Named pipe not found at ${socketPath}. Ensure Discord bot is running on Windows.`);
                    }

                    resolve(null);
                });
            });
        } catch (error) {
            clearTimeout(connectionTimeout);
            console.error(`Error creating IPC connection: ${error.message}`);
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

                try {
                    // Get IPC connection
                    const ipcClient = await createIPCConnection(credHash);

                    if (!ipcClient) {
                        clearTimeout(timeout);
                        return resolve([]);
                    }

                    // Set up event listener for response
                    const responseHandler = (data: { name: string; value: string }[]) => {
                        clearTimeout(timeout);
                        ipcClient.off('list:channels', responseHandler);
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

                try {
                    // Get IPC connection
                    const ipcClient = await createIPCConnection(credHash);

                    if (!ipcClient) {
                        clearTimeout(timeout);
                        return resolve([]);
                    }

                    // Set up event listener for response
                    const responseHandler = (data: { name: string; value: string }[]) => {
                        clearTimeout(timeout);
                        ipcClient.off('list:guilds', responseHandler);
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

                try {
                    // Get IPC connection
                    const ipcClient = await createIPCConnection(credHash);

                    if (!ipcClient) {
                        clearTimeout(timeout);
                        return resolve([]);
                    }

                    // Set up event listener for response
                    const responseHandler = (data: any) => {
                        clearTimeout(timeout);
                        ipcClient.off('list:roles', responseHandler);
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

            try {
                // Get IPC connection
                const ipcClient = await createIPCConnection(credHash);

                if (!ipcClient) {
                    clearTimeout(timeout);
                    return resolve(null);
                }

                // Set up response handler
                const responseHandler = (data: any) => {
                    clearTimeout(timeout);
                    // Remove the listener to prevent memory leaks
                    ipcClient.off(`callback:${type}`, responseHandler);
                    resolve(data);
                };

                ipcClient.on(`callback:${type}`, responseHandler);

                // Send the request
                ipcClient.emit(type, {
                    nodeParameters: parameters,
                    credentialHash: credHash
                });
            } catch (error) {
                console.error(`Error in ${type} request:`, error);
                clearTimeout(timeout);
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

        return new Promise(async (resolve) => {
            const timeout = setTimeout(() => {
                console.log(`Cleanup request timed out after 5 seconds`);
                resolve(false);
            }, 5000);

            try {
                // Get IPC connection
                const ipcClient = await createIPCConnection(credHash);

                if (!ipcClient) {
                    clearTimeout(timeout);
                    return resolve(false);
                }

                // Set up response handler
                const responseHandler = (data: any) => {
                    clearTimeout(timeout);
                    // Clean up this connection from the cache
                    delete connectionCache[credHash];
                    // Remove the listener to prevent memory leaks
                    ipcClient.off('cleanupBot:response', responseHandler);

                    try {
                        // Disconnect this IPC connection
                        ipc.disconnect('bot');
                    } catch (err) {
                        console.error('Error disconnecting IPC during cleanup:', err);
                    }

                    resolve(data.success);
                };

                ipcClient.on('cleanupBot:response', responseHandler);

                // Send the cleanup request
                ipcClient.emit('cleanupBot', {
                    nodeId,
                    credentialHash: credHash
                });
            } catch (error) {
                console.error('Error in cleanupBot request:', error);
                clearTimeout(timeout);
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
