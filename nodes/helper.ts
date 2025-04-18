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
    // We'll use the fixed path that's working in the logs: /tmp/bot
    return '/tmp/bot';
}

// Initialize IPC configuration once to prevent duplicate setup
function initializeIPC() {
    if (global.__n8nDiscordIPCInitialized) {
        return;
    }
    
    // Configure IPC for Unix environment (Ubuntu 22.04)
    ipc.config.retry = 1500;
    ipc.config.silent = false; // Enable logs for debugging
    ipc.config.socketRoot = '/tmp/';
    ipc.config.appspace = '';
    ipc.config.maxRetries = 10;
    ipc.config.stopRetrying = false;
    
    // Mark as initialized
    global.__n8nDiscordIPCInitialized = true;
    console.log('IPC configuration initialized');
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
        
        // Use the fixed socket path for Ubuntu 22.04
        const socketPath = getSocketPath();
        
        console.log(`IPC Client Configuration: Socket Root: ${ipc.config.socketRoot}, Socket Path: ${socketPath}`);
        
        // Set timeout for connection attempt
        const timeout = setTimeout(() => reject(new Error('Connection timeout after 15 seconds')), 15000);
        
        // Check if we already have an active connection
        if (connectionCache[credHash]) {
            clearTimeout(timeout);
            console.log(`Using existing connection for credential hash: ${credHash}`);
            return resolve('already');
        }
        
        ipc.connectTo('bot', socketPath, () => {
            console.log('Attempting to connect to IPC server at:', socketPath);
            
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
            
            ipc.of.bot.on('error', (err: any) => {
                console.error('IPC connection error:', err);
                connectionCache[credHash] = false;
                clearTimeout(timeout);
                reject(new Error(`IPC error: ${err.message || 'Unknown error'}`));
            });
            
            ipc.of.bot.on('disconnect', () => {
                console.log(`IPC connection disconnected for ${credHash}`);
                connectionCache[credHash] = false;
            });
        });
    });
};


// Helper function to create a reusable IPC connection
function createIPCConnection(credentialHash: string): Promise<any> {
    return new Promise((resolve) => {
        // Initialize IPC configuration
        initializeIPC();
        
        const socketPath = getSocketPath();
        
        // No need to re-configure IPC here since we've initialized it already
        ipc.connectTo('bot', socketPath, () => {
            ipc.of.bot.on('connect', function() {
                console.log(`IPC connection established for request with credential hash ${credentialHash}`);
                resolve(ipc.of.bot);
            });
            
            ipc.of.bot.on('error', function(err: any) {
                console.error('IPC connection error in helper function:', err);
                resolve(null);
            });
        });
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


function removeTrailingSlash(url: String) {
    if (url.endsWith('/')) {
        return url.slice(0, -1);
    }
    return url;
}