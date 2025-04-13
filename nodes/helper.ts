import ipc from 'node-ipc';
import { INodePropertyOptions } from 'n8n-workflow';
import axios from "axios";
// import * as path from 'path';
// import * as os from 'os';
// import * as fs from 'fs';

// Add type declaration for the global property
declare global {
    var __n8nDiscordSocketPath: string;
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

export const connection = (credentials: ICredentials): Promise<string> => {
    return new Promise((resolve, reject) => {
        if (!credentials || !credentials.token || !credentials.clientId) {
            reject('credentials missing');
            return;
        }

        const timeout = setTimeout(() => reject('timeout'), 15000);
        
        // Use the fixed socket path that works
        const socketPath = getSocketPath();
        
        // Configure IPC for Unix environment
        ipc.config.retry = 1500;
        ipc.config.silent = false; // Enable logs for debugging
        ipc.config.socketRoot = '/tmp/';
        ipc.config.appspace = '';
        ipc.config.maxRetries = 10;
        ipc.config.stopRetrying = false;
        
        console.log(`IPC Client Configuration: Socket Root: ${ipc.config.socketRoot}, Socket Path: ${socketPath}`);
        
        ipc.connectTo('bot', socketPath, () => {
            console.log('Attempting to connect to IPC server at:', socketPath);
            
            ipc.of.bot.on('connect', () => {
                console.log('Successfully connected to IPC server');
                ipc.of.bot.emit('credentials', credentials);
            });
            
            ipc.of.bot.on('credentials', (data: string) => {
                clearTimeout(timeout);
                if (data === 'error') reject('Invalid credentials');
                else if (data === 'missing') reject('Token or clientId missing');
                else if (data === 'login') reject('Already logging in');
                else if (data === 'different') resolve('Already logging in with different credentials');
                else resolve(data); // ready / already
            });
            
            ipc.of.bot.on('error', (err: any) => {
                console.error('IPC connection error:', err);
                reject(`IPC error: ${err.message || 'Unknown error'}`);
            });
        });
    });
};


export const getChannels = async (that: any, guildIds: string[]): Promise<INodePropertyOptions[]> => {
    const endMessage = ' - Close and reopen this node modal once you have made changes.';

    const credentials = await that.getCredentials('discordBotTriggerApi').catch((e: any) => e);
    const res = await connection(credentials).catch((e) => e);
    if (!['ready', 'already'].includes(res)) {
        return [
            {
                name: res + endMessage,
                value: 'false',
            },
        ];
    }

    const channelsRequest = () =>
        new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(''), 5000);
            const socketPath = getSocketPath();
            
            ipc.config.retry = 1500;
            ipc.config.silent = false;
            ipc.config.socketRoot = '/tmp/';
            ipc.config.appspace = '';
            
            console.log(`Channels Request: Connecting to IPC server at ${socketPath}`);
            
            ipc.connectTo('bot', socketPath, () => {
                ipc.of.bot.on('connect', () => {
                    console.log('Connected to IPC server for channels request');
                    ipc.of.bot.emit('list:channels', guildIds);
                });

                ipc.of.bot.on('list:channels', (data: { name: string; value: string }[]) => {
                    clearTimeout(timeout);
                    resolve(data);
                });
                
                ipc.of.bot.on('error', (err: any) => {
                    console.error('IPC connection error in getChannels:', err);
                    resolve('');
                });
            });
        });

    const channels = await channelsRequest().catch((e) => e);

    let message = 'Unexpected error';

    if (channels) {
        if (Array.isArray(channels) && channels.length) return channels;
        else
            message =
                'Your Discord server has no text channels, please add at least one text channel' +
                endMessage;
    }

    return [
        {
            name: message,
            value: 'false',
        },
    ];
};


export const getGuilds = async (that: any): Promise<INodePropertyOptions[]> => {
    const endMessage = ' - Close and reopen this node modal once you have made changes.';

    const credentials = await that.getCredentials('discordBotTriggerApi').catch((e: any) => e);
    const res = await connection(credentials).catch((e) => e);
    if (!['ready', 'already'].includes(res)) {
        return [
            {
                name: res + endMessage,
                value: 'false',
            },
        ];
    }

    const guildsRequest = () =>
        new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(''), 5000);
            const socketPath = getSocketPath();
            
            ipc.config.retry = 1500;
            ipc.config.silent = false;
            ipc.config.socketRoot = '/tmp/';
            ipc.config.appspace = '';
            
            console.log(`Guilds Request: Connecting to IPC server at ${socketPath}`);
            
            ipc.connectTo('bot', socketPath, () => {
                ipc.of.bot.on('connect', () => {
                    console.log('Connected to IPC server for guilds request');
                    ipc.of.bot.emit('list:guilds');
                });

                ipc.of.bot.on('list:guilds', (data: { name: string; value: string }[]) => {
                    clearTimeout(timeout);
                    resolve(data);
                });
                
                ipc.of.bot.on('error', (err: any) => {
                    console.error('IPC connection error in getGuilds:', err);
                    resolve('');
                });
            });
        });

    const guilds = await guildsRequest().catch((e) => e);

    let message = 'Unexpected error';

    if (guilds) {
        if (Array.isArray(guilds) && guilds.length) return guilds;
        else
            message =
                'Your bot is not part of any guilds. Please add the bot to at least one guild.' +
                endMessage;
    }

    return [
        {
            name: message,
            value: 'false',
        },
    ];
};

export interface IRole {
    name: string;
    id: string;
}

export const getRoles = async (that: any, selectedGuildIds: string[]): Promise<INodePropertyOptions[]> => {
    const endMessage = ' - Close and reopen this node modal once you have made changes.';

    const credentials = await that.getCredentials('discordBotTriggerApi').catch((e: any) => e);
    const res = await connection(credentials).catch((e) => e);
    if (!['ready', 'already'].includes(res)) {
        return [
            {
                name: res + endMessage,
                value: 'false',
            },
        ];
    }

    const rolesRequest = () =>
        new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(''), 5000);
            const socketPath = getSocketPath();
            
            ipc.config.retry = 1500;
            ipc.config.silent = false;
            ipc.config.socketRoot = '/tmp/';
            ipc.config.appspace = '';
            
            console.log(`Roles Request: Connecting to IPC server at ${socketPath}`);
            
            ipc.connectTo('bot', socketPath, () => {
                ipc.of.bot.on('connect', () => {
                    console.log('Connected to IPC server for roles request');
                    ipc.of.bot.emit('list:roles', selectedGuildIds);
                });

                ipc.of.bot.on('list:roles', (data: any) => {
                    clearTimeout(timeout);
                    resolve(data);
                });
                
                ipc.of.bot.on('error', (err: any) => {
                    console.error('IPC connection error in getRoles:', err);
                    resolve('');
                });
            });
        });

    const roles = await rolesRequest().catch((e) => e);

    let message = 'Unexpected error';

    if (roles) {
        if (Array.isArray(roles)) {
            const filtered = roles.filter((r: any) => r.name !== '@everyone');
            if (filtered.length) return filtered;
            else
                message =
                    'Your Discord server has no roles, please add at least one if you want to restrict the trigger to specific users' +
                    endMessage;
        } else message = 'Something went wrong' + endMessage;
    }

    return [
        {
            name: message,
            value: 'false',
        },
    ];
};


export const checkWorkflowStatus = async (n8nApiUrl: String, apiToken: String, workflowId: String): Promise<boolean> => {
    const apiUrl = `${removeTrailingSlash(n8nApiUrl)}/workflows/${workflowId}`;
    return new Promise((resolve, reject) => {
        axios.get(apiUrl, {
            headers: {
                'X-N8N-API-KEY': `${apiToken}`,
            },
        }).then(response => {
            // return if workflow is active or not
            resolve(response.data.active);
        }).catch(e => {
            console.error('Error checking workflow status:', e.message);
            reject(e);
        });
    });
}



export const ipcRequest = (type: string, parameters: any): Promise<any> => {
    return new Promise((resolve) => {
        const socketPath = getSocketPath();
        
        ipc.config.retry = 1500;
        ipc.config.silent = false;
        ipc.config.socketRoot = '/tmp/';
        ipc.config.appspace = '';
        
        console.log(`IPC Request (${type}): Connecting to IPC server at ${socketPath}`);
        
        ipc.connectTo('bot', socketPath, () => {
            ipc.of.bot.on('connect', () => {
                console.log(`Connected to IPC server for "${type}" request`);
                ipc.of.bot.emit(type, parameters);
            });
            
            ipc.of.bot.on(`callback:${type}`, (data: any) => {
                console.log(`Response received for "${type}" request:`, data);
                resolve(data);
            });
            
            ipc.of.bot.on('error', (err: any) => {
                console.error(`IPC connection error in "${type}" request:`, err);
                resolve(null);
            });
        });
    });
};


function removeTrailingSlash(url: String) {
    if (url.endsWith('/')) {
        return url.slice(0, -1);
    }
    return url;
}