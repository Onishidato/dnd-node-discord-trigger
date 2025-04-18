import {
    Client, GatewayIntentBits, ChannelType, Guild,
    EmbedBuilder,
    ColorResolvable,
    AttachmentBuilder,
    TextChannel,
    Message,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ButtonInteraction,
    Collection
} from 'discord.js';

import ipc from 'node-ipc';
import {
    ICredentials,
} from './helper';
import * as fs from 'fs';
import * as os from 'os';

// Add type declaration for settings
import settings from './settings';
declare module './settings' {
    interface Settings {
        triggerNodes: { [key: string]: ITriggerNode };
        botInstances: { [key: string]: IBotInstance };
    }
}

// Add type declaration for the global property
declare global {
    var __n8nDiscordSocketPath: string;
    var __n8nDiscordIPCInitialized: boolean;
    var __n8nDiscordServerStarted: boolean;
}

// Define types for the settings objects to improve type safety
interface ITriggerNode {
    node: INode;
    webhook: IWebhookData;
    credHash: string;
    credentialHash: string; // Add this to match settings.ts
    workflowId: string;
    executeTrigger: (msg: Message) => Promise<IWorkflowExecuteAdditionalData>;
    active: boolean; // Changed from optional to required to avoid type conflicts
    parameters: {
        id: string;
        name: string;
        type: string;
        pattern?: string;
        value?: string;
        caseSensitive?: boolean;
        guildIds?: string[];
        roleIds?: string[];
        channelIds?: string[];
        messageReferenceRequired?: boolean;
        additionalFields?: {
            externalBotTrigger?: boolean;
        };
        placeholder?: string;
    };
}

// Add missing interface definitions
interface INode {
    // Define minimum required properties
    id: string;
    name: string;
    type: string;
}

interface IWebhookData {
    // Define minimum required properties
    httpMethod: string;
    path: string;
}

interface IWorkflow {
    // Define minimum required properties
    id: string;
}

interface IWorkflowExecuteAdditionalData {
    // Define minimum required properties
}

// Update IBotInstance interface
interface IBotInstance {
    id: string;
    client: Client;
    triggerNodes: { [key: string]: ITriggerNode };
    ready: boolean;
    login: boolean;
    clientId: string;
    token: string;
    baseUrl: string; // Changed from optional to required to match settings.ts
    parameters: any; // Changed from optional to required to match implementation
}

// Store clients for different Discord accounts
const clients: { [credentialHash: string]: Client } = {};

// Track active connections for cleanup
const activeConnections: Set<string> = new Set();

// Store placeholders for running workflows
const placeholders: { [nodeId: string]: { message: Message, interval: NodeJS.Timeout } } = {};

// Store message queues for each node
const messageQueues: { [nodeId: string]: any[] } = {};

export default function (): void {
    // Prevent multiple instances of the bot server
    if (global.__n8nDiscordServerStarted) {
        console.log('Bot server already started, skipping initialization');
        return;
    }

    // Choose socket path based on operating system
    // Windows uses named pipes, Unix-like systems use Unix domain sockets
    const socketPath = os.platform() === 'win32'
        ? '\\\\.\\pipe\\n8n-discord-bot'  // Windows named pipe - must match helper.ts
        : '/tmp/bot';                     // Unix domain socket

    console.log(`Using socket path: ${socketPath}`);

    // Clean up any existing socket file to prevent EADDRINUSE errors
    // Only needed for Unix platforms, not for Windows named pipes
    if (os.platform() !== 'win32' && fs.existsSync(socketPath)) {
        try {
            fs.unlinkSync(socketPath);
            console.log(`Removed existing socket file at ${socketPath}`);
        } catch (err) {
            console.error(`Error cleaning up socket file:`, err);
        }
    }

    // Configure IPC
    ipc.config.id = 'bot';
    ipc.config.retry = 1500;
    ipc.config.silent = false; // Enable logs for debugging

    // Set different socket configurations depending on the OS
    if (os.platform() === 'win32') {
        ipc.config.networkHost = 'localhost';        // Only needed for Windows
        ipc.config.networkPort = 8000;              // Only needed for Windows
    } else {
        ipc.config.socketRoot = '/tmp/';            // Unix socket path
        ipc.config.appspace = '';                   // Unix socket option
        ipc.config.unlink = true;                   // Clean up socket on exit
    }

    ipc.config.maxRetries = 10;                     // Set maximum retries
    ipc.config.stopRetrying = false;                // Don't stop retrying

    console.log(`IPC Server Configuration: ${os.platform() === 'win32' ? 'Windows Named Pipe' : 'Unix Socket'}`);
    console.log(`Expected socket path: ${socketPath}`);

    // Export the socket path so helper.ts can use it
    if (typeof global.__n8nDiscordSocketPath === 'undefined') {
        Object.defineProperty(global, '__n8nDiscordSocketPath', {
            value: socketPath,
            writable: false,
            configurable: false,
        });
    }

    // Mark server as started to prevent duplicate initialization
    global.__n8nDiscordServerStarted = true;

    // Helper function to create a new Discord client
    function createNewClient(credentials: ICredentials): Client {
        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildPresences,
                GatewayIntentBits.GuildBans,
                GatewayIntentBits.GuildMessageReactions,
                GatewayIntentBits.GuildMessageTyping,
            ],
            allowedMentions: {
                parse: ['roles', 'users', 'everyone'],
            },
        });

        client.once('ready', () => {
            console.log(`Logged in as ${client.user?.tag} (Client ID: ${credentials.clientId})`);
        });

        // Set up onMessageCreate handler for this specific client
        setupClientMessageHandler(client);

        return client;
    }

    // Helper function to setup message handler for a client
    function setupClientMessageHandler(client: Client): void {
        client.on('messageCreate', async (message: Message) => {
            try {
                // Get all relevant node IDs for this client
                const relevantNodeIds = Object.entries(settings.triggerNodes)
                    .filter(([_, data]) => {
                        const credHash = (data as unknown as ITriggerNode).credHash;
                        const botInstance = settings.botInstances[credHash] as IBotInstance | undefined;
                        return botInstance && botInstance.clientId === client.application?.id;
                    })
                    .map(([nodeId, _]) => nodeId);

                if (relevantNodeIds.length === 0) return;

                // resolve the message reference if it exists
                let messageReference: Message | null = null;
                let messageReferenceFetched = !message.reference;

                // Instead of checking each node's parameters after common checks,
                // process each node independently to ensure proper isolation
                for (const nodeId of relevantNodeIds) {
                    try {
                        const parameters = (settings.triggerNodes[nodeId] as unknown as ITriggerNode)?.parameters;
                        if (!parameters) continue;

                        // Get specific pattern for this node
                        const pattern = parameters.pattern as string;
                        const triggerOnExternalBot = parameters.additionalFields?.externalBotTrigger || false;

                        // Check if this node should process bot messages
                        if (!triggerOnExternalBot) {
                            if (message.author.bot || message.author.system) continue;
                        }
                        else if (message.author.id === message.client.user?.id) continue;

                        // Check guild restrictions for this specific node
                        if (parameters.guildIds && parameters.guildIds.length > 0) {
                            const isInGuild = message.guild?.id ? parameters.guildIds.includes(message.guild.id) : false;
                            if (!isInGuild) continue;
                        }

                        // Check role restrictions for this specific node
                        const userRoles = message.member?.roles.cache.map((role) => role.id);
                        if (parameters.roleIds && parameters.roleIds.length) {
                            const hasRole = parameters.roleIds.some((role: string) => userRoles?.includes(role));
                            if (!hasRole) continue;
                        }

                        // Check channel restrictions for this specific node
                        if (parameters.channelIds && parameters.channelIds.length) {
                            const isInChannel = parameters.channelIds.some((channelId: string) =>
                                message.channel.id?.includes(channelId)
                            );
                            if (!isInChannel) continue;
                        }

                        // Check reference requirement for this specific node
                        if (parameters.messageReferenceRequired && !message.reference) {
                            continue;
                        }

                        // Fetch message reference if needed - only once per message processing
                        if (!messageReferenceFetched && message.reference) {
                            try {
                                messageReference = await message.fetchReference();
                                messageReferenceFetched = true;
                            } catch (e) {
                                console.log(`Error fetching message reference:`, e);
                            }
                        }

                        const clientId = client.user?.id;
                        if (!clientId) continue;

                        // Prepare regex and other checks for this specific node
                        const escapedTriggerValue = String(parameters.value || '')
                            .replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
                            .replace(/-/g, '\\x2d');

                        // Bot mention detection for this specific node
                        const mentionRegex = new RegExp(`<@!?${clientId}>|<@${clientId}>`, 'g');
                        const botMention = message.mentions.users.some((user) => user.id === clientId) ||
                                        mentionRegex.test(message.content || '');

                        // Image attachment check for this specific node
                        const hasImageAttachments = message.attachments.some(attachment => {
                            const contentType = attachment.contentType?.toLowerCase() || '';
                            // First check by content type
                            if (contentType.startsWith('image/')) {
                                return true;
                            }

                            // If content type is missing or unknown, check file extension
                            if (!contentType && attachment.name) {
                                const extension = attachment.name.split('.').pop()?.toLowerCase();
                                return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff'].includes(extension || '');
                            }

                            return false;
                        });

                        // Select regex pattern based on this node's configuration
                        let regStr = `^${escapedTriggerValue}$`;

                        if (pattern === "botMention" && !botMention) {
                            continue;
                        }
                        else if (pattern === "containImage" && !hasImageAttachments) {
                            continue;
                        }
                        else if (pattern === "start" && message.content)
                            regStr = `^${escapedTriggerValue}`;
                        else if (pattern === 'end')
                            regStr = `${escapedTriggerValue}$`;
                        else if (pattern === 'contain')
                            regStr = `${escapedTriggerValue}`;
                        else if (pattern === 'regex')
                            regStr = `${parameters.value}`;
                        else if (pattern === 'every')
                            regStr = `(.*)`;

                        const reg = new RegExp(regStr, parameters.caseSensitive ? '' : 'i');
                        const messageContent = message.content || '';

                        // Check if the message matches this node's pattern
                        if ((pattern === "botMention" && botMention) ||
                            (pattern === "containImage" && hasImageAttachments) ||
                            (pattern !== "botMention" && pattern !== "containImage" && reg.test(messageContent))) {

                            // For bot mentions, clean up the content
                            let processedContent = messageContent;
                            if (pattern === "botMention" && botMention) {
                                processedContent = messageContent.replace(mentionRegex, '').trim();
                            }

                            // Before emitting message data, check if the workflow is still active
                            // We store this in the triggerNodes object
                            const nodeInfo = settings.triggerNodes[nodeId];
                            if (!nodeInfo) {
                                console.log(`Skipping trigger for unregistered node: ${nodeId}`);
                                return;
                            }

                            // Allow messages to be processed even if the node is not active
                            // This is necessary for test workflows in n8n
                            // The workflow will only actually execute if it's being tested or is active

                            console.log(`Trigger activated for node ${nodeId}. Pattern: ${pattern}, botMention: ${botMention}, hasImageAttachments: ${hasImageAttachments}, guild: ${message.guild?.name || 'DM'} (${message.guild?.id || 'none'})`);

                            // Send placeholder message if configured
                            if (parameters.placeholder && parameters.placeholder.trim() !== '') {
                                sendPlaceholderMessage(nodeId, message.channel as TextChannel, parameters.placeholder);
                            }

                            // Emit the message data specifically to this node
                            const messageData = {
                                message: {
                                    ...message,
                                    processedContent: pattern === "botMention" ? processedContent : messageContent
                                },
                                messageReference,
                                referenceAuthor: messageReference?.author,
                                author: message.author,
                                nodeId: nodeId
                            };

                            // Send message only to this specific node
                            ipc.server.broadcast('messageCreate', messageData);
                        }
                    } catch (e) {
                        console.error(`Error processing message for node ${nodeId}:`, e);
                    }
                }
            } catch (error) {
                console.error('Error in message handler:', error);
            }
        });
    }

    // Function to send a placeholder message with animated dots
    async function sendPlaceholderMessage(nodeId: string, channel: TextChannel, placeholderText: string): Promise<void> {
        try {
            // Clean up any existing placeholder for this node
            clearPlaceholder(nodeId);

            // Send the initial placeholder message
            const message = await channel.send(placeholderText);

            // Set up an interval to add animated dots
            const dotsInterval = setInterval(async () => {
                try {
                    if (message.deletable) {
                        const dots = ['.', '..', '...'];
                        const currentTime = new Date().getTime();
                        const dotIndex = Math.floor((currentTime / 1000) % 3);

                        await message.edit(`${placeholderText}${dots[dotIndex]}`);
                    } else {
                        // Message was deleted, clear the interval
                        clearInterval(dotsInterval);
                        delete placeholders[nodeId];
                    }
                } catch (error) {
                    console.error(`Error updating placeholder dots:`, error);
                    clearInterval(dotsInterval);
                    delete placeholders[nodeId];
                }
            }, 1000);

            // Store the placeholder reference
            placeholders[nodeId] = {
                message,
                interval: dotsInterval
            };
        } catch (error) {
            console.error(`Error sending placeholder message:`, error);
        }
    }

    // Function to clear a placeholder
    function clearPlaceholder(nodeId: string): void {
        if (placeholders[nodeId]) {
            // Clear the interval
            clearInterval(placeholders[nodeId].interval);

            // Try to delete the message if it still exists
            try {
                if (placeholders[nodeId].message.deletable) {
                    placeholders[nodeId].message.delete().catch(error => {
                        console.error(`Error deleting placeholder message:`, error);
                    });
                }
            } catch (error) {
                console.error(`Error cleaning up placeholder:`, error);
            }

            // Remove from placeholder storage
            delete placeholders[nodeId];
        }
    }

    // Type for the message object sent to Discord
    interface MessageOptions {
        content?: string;
        embeds?: EmbedBuilder[];
        files?: any[];
        components?: any;
    }

    // Function to prepare message for sending to Discord
    function prepareMessage(nodeParameters: Record<string, any>): MessageOptions {
        // prepare embed messages, if they are set by the client
        const embedFiles: AttachmentBuilder[] = [];
        let embed: EmbedBuilder | undefined;

        if (nodeParameters.embed) {
            embed = new EmbedBuilder();
            if (nodeParameters.title) embed.setTitle(nodeParameters.title);
            if (nodeParameters.url) embed.setURL(nodeParameters.url);
            if (nodeParameters.description) embed.setDescription(nodeParameters.description);
            if (nodeParameters.color) embed.setColor(nodeParameters.color as ColorResolvable);
            if (nodeParameters.timestamp) embed.setTimestamp(new Date(nodeParameters.timestamp));

            // Handle footer with optional icon
            if (nodeParameters.footerText) {
                let iconURL = nodeParameters.footerIconUrl;
                if (iconURL && typeof iconURL === 'string' && iconURL.match(/^data:/)) {
                    const buffer = Buffer.from(iconURL.split(',')[1], 'base64');
                    const mimeMatch = /data:image\/([a-z]+);base64/.exec(iconURL);
                    const extension = mimeMatch?.[1] || 'png';
                    const file = new AttachmentBuilder(buffer, { name: `footer.${extension}` });
                    embedFiles.push(file);
                    iconURL = `attachment://footer.${extension}`;
                }
                embed.setFooter({
                    text: nodeParameters.footerText,
                    iconURL: iconURL || undefined,
                });
            }

            // Handle image
            if (nodeParameters.imageUrl && typeof nodeParameters.imageUrl === 'string') {
                if (nodeParameters.imageUrl.match(/^data:/)) {
                    const buffer = Buffer.from(nodeParameters.imageUrl.split(',')[1], 'base64');
                    const mimeMatch = /data:image\/([a-z]+);base64/.exec(nodeParameters.imageUrl);
                    const extension = mimeMatch?.[1] || 'png';
                    const file = new AttachmentBuilder(buffer, { name: `image.${extension}` });
                    embedFiles.push(file);
                    embed.setImage(`attachment://image.${extension}`);
                } else {
                    embed.setImage(nodeParameters.imageUrl);
                }
            }

            // Handle thumbnail
            if (nodeParameters.thumbnailUrl && typeof nodeParameters.thumbnailUrl === 'string') {
                if (nodeParameters.thumbnailUrl.match(/^data:/)) {
                    const buffer = Buffer.from(nodeParameters.thumbnailUrl.split(',')[1], 'base64');
                    const mimeMatch = /data:image\/([a-z]+);base64/.exec(nodeParameters.thumbnailUrl);
                    const extension = mimeMatch?.[1] || 'png';
                    const file = new AttachmentBuilder(buffer, { name: `thumbnail.${extension}` });
                    embedFiles.push(file);
                    embed.setThumbnail(`attachment://thumbnail.${extension}`);
                } else {
                    embed.setThumbnail(nodeParameters.thumbnailUrl);
                }
            }

            // Handle author with optional icon and URL
            if (nodeParameters.authorName) {
                let iconURL = nodeParameters.authorIconUrl;
                if (iconURL && typeof iconURL === 'string' && iconURL.match(/^data:/)) {
                    const buffer = Buffer.from(iconURL.split(',')[1], 'base64');
                    const mimeMatch = /data:image\/([a-z]+);base64/.exec(iconURL);
                    const extension = mimeMatch?.[1] || 'png';
                    const file = new AttachmentBuilder(buffer, { name: `author.${extension}` });
                    embedFiles.push(file);
                    iconURL = `attachment://author.${extension}`;
                }
                embed.setAuthor({
                    name: nodeParameters.authorName,
                    iconURL: iconURL || undefined,
                    url: nodeParameters.authorUrl || undefined,
                });
            }

            // Handle fields
            if (nodeParameters.fields?.field) {
                nodeParameters.fields.field.forEach((field: any) => {
                    if (embed && field.name && field.value) {
                        embed.addFields({
                            name: field.name,
                            value: field.value,
                            inline: field.inline || false,
                        });
                    } else if (embed) {
                        embed.addFields({ name: '\u200B', value: '\u200B' });
                    }
                });
            }
        }

        // Handle content and role mentions
        let content = nodeParameters.content || '';

        if (nodeParameters.mentionRoles && Array.isArray(nodeParameters.mentionRoles)) {
            nodeParameters.mentionRoles.forEach((role: string) => {
                content += ` <@&${role}>`;
            });
        }

        // Handle file attachments
        let files: any[] = [];

        if (nodeParameters.files?.file) {
            files = nodeParameters.files.file.map((file: any) => {
                if (file.url && typeof file.url === 'string' && file.url.match(/^data:/)) {
                    return Buffer.from(file.url.split(',')[1], 'base64');
                }
                return file.url;
            });
        }

        // Add embed attachment files if any
        if (embedFiles.length) {
            files = files.concat(embedFiles);
        }

        // Create the final message object
        return {
            content: content || undefined,
            embeds: embed ? [embed] : undefined,
            files: files.length ? files : undefined,
            components: nodeParameters.components || undefined,
        };
    }

    // Setup process exit handlers to cleanup resources
    process.on('SIGINT', cleanupAndExit);
    process.on('SIGTERM', cleanupAndExit);
    process.on('exit', cleanupAndExit);

    function cleanupAndExit(): void {
        console.log('Bot process exiting, cleaning up resources...');

        // Destroy all client connections
        Object.values(clients).forEach(client => {
            try {
                client.destroy();
                console.log(`Client ${client.application?.id} destroyed`);
            } catch (err) {
                console.error(`Error destroying client:`, err);
            }
        });

        // Clear all stored instances
        settings.botInstances = {};
        settings.triggerNodes = {};

        // Stop IPC server if it's running
        try {
            if (ipc.server) {
                ipc.server.stop();
                console.log('IPC server stopped');
            }
        } catch (err) {
            console.error(`Error stopping IPC server:`, err);
        }

        // Remove socket file if it still exists (Unix only)
        if (os.platform() !== 'win32' && fs.existsSync(socketPath)) {
            try {
                fs.unlinkSync(socketPath);
                console.log(`Removed socket file at ${socketPath}`);
            } catch (err) {
                console.error(`Error removing socket file:`, err);
            }
        }

        console.log('Cleanup complete');
    }

    // nodes are executed in a child process, the Discord bot is executed in the main process
    // so it's not stopped when a node execution end
    // we use ipc to communicate between the node execution process and the bot
    // ipc is serving in the main process & childs connect to it using the ipc client
    ipc.serve(socketPath, function () {
        console.log(`IPC bot server started on ${socketPath}`);

        // Track connected sockets for better resource management
        const connectedSockets = new Set<any>();

        ipc.server.on('connect', function(socket) {
            connectedSockets.add(socket);
            console.log(`New socket connection established. Total connections: ${connectedSockets.size}`);
        });

        ipc.server.on('socket.disconnected', function(socket) {
            connectedSockets.delete(socket);
            console.log(`Socket disconnected. Remaining connections: ${connectedSockets.size}`);
        });

        ipc.server.on('triggerNodeRegistered', function(data, socket) {
            try {
                const { nodeId } = data.nodeParameters;

                if (!nodeId) {
                    console.error('Missing nodeId in triggerNodeRegistered request');
                    ipc.server.emit(socket, `callback:triggerNodeRegistered`, { success: false });
                    return;
                }

                // Track this node for future reference
                settings.triggerNodes[nodeId] = data.nodeParameters;
                console.log(`Registered trigger node ${nodeId}`);

                // Initialize message queue for this node if it doesn't exist
                if (!messageQueues[nodeId]) {
                    messageQueues[nodeId] = [];
                }

                ipc.server.emit(socket, `callback:triggerNodeRegistered`, { success: true });
            } catch (error) {
                console.error('Error handling triggerNodeRegistered:', error);
                ipc.server.emit(socket, `callback:triggerNodeRegistered`, { success: false, error: error.message });
            }
        });

        // Handle requests for new messages
        ipc.server.on('getNewMessages', function(data, socket) {
            try {
                const { nodeId } = data.nodeParameters;

                if (!nodeId) {
                    console.error('Missing nodeId in getNewMessages request');
                    ipc.server.emit(socket, `callback:getNewMessages`, { success: false });
                    return;
                }

                // Return any queued messages for this node
                const messages = messageQueues[nodeId] || [];

                // Clear the queue after sending
                messageQueues[nodeId] = [];

                ipc.server.emit(socket, `callback:getNewMessages`, {
                    success: true,
                    messages: messages
                });
            } catch (error) {
                console.error('Error handling getNewMessages:', error);
                ipc.server.emit(socket, `callback:getNewMessages`, {
                    success: false,
                    error: error.message
                });
            }
        });

        // Handle workflow execution finished notification
        ipc.server.on('workflowExecutionFinished', function(data, socket) {
            try {
                const { executionId, nodeId } = data.nodeParameters;

                if (!nodeId || !executionId) {
                    console.error('Missing nodeId or executionId in workflowExecutionFinished request');
                    ipc.server.emit(socket, `callback:workflowExecutionFinished`, { success: false });
                    return;
                }

                // Clear any placeholder messages that might have been sent
                // when this workflow started executing

                ipc.server.emit(socket, `callback:workflowExecutionFinished`, { success: true });
            } catch (error) {
                console.error('Error handling workflowExecutionFinished:', error);
                ipc.server.emit(socket, `callback:workflowExecutionFinished`, { success: false, error: error.message });
            }
        });

        // Handle update trigger node status
        ipc.server.on('updateTriggerNodeStatus', function(data, socket) {
            try {
                // Support both data formats for consistency
                // Format 1: { nodeParameters: { nodeId, active }, credentialHash: '...' }
                // Format 2: { nodeId: '...', active: true/false }
                const nodeId = data.nodeParameters?.nodeId || data.nodeId;
                const active = data.nodeParameters?.active !== undefined ? data.nodeParameters.active : data.active;
                const credHash = data.credentialHash;

                if (!nodeId || typeof active !== 'boolean') {
                    console.error('Missing nodeId or active status in updateTriggerNodeStatus event');
                    ipc.server.emit(socket, 'updateTriggerNodeStatus:response', {
                        success: false,
                        error: 'Missing nodeId or active status'
                    });
                    return;
                }

                if (settings.triggerNodes[nodeId]) {
                    settings.triggerNodes[nodeId].active = active;
                    console.log(`Updated trigger node ${nodeId} status to ${active}`);

                    // Also update in the bot instance if available
                    if (credHash && settings.botInstances[credHash]) {
                        if ((!settings.botInstances[credHash] as any).triggerNodes) {
                            (settings.botInstances[credHash] as any).triggerNodes = {};
                        }
                        (settings.botInstances[credHash] as any).triggerNodes[nodeId] = {
                            ...(settings.triggerNodes[nodeId] as any),
                            active
                        };
                    }

                    ipc.server.emit(socket, 'updateTriggerNodeStatus:response', {
                        success: true,
                        nodeId: nodeId,
                        active: active
                    });
                } else {
                    console.error(`Trigger node ${nodeId} not found`);
                    ipc.server.emit(socket, 'updateTriggerNodeStatus:response', {
                        success: false,
                        error: `Trigger node ${nodeId} not found`
                    });
                }
            } catch (e) {
                console.error(`Error handling updateTriggerNodeStatus:`, e);
                ipc.server.emit(socket, 'updateTriggerNodeStatus:response', {
                    success: false,
                    error: String(e)
                });
            }
        });

        // Handle node deactivation
        ipc.server.on('deactivateNode', function(data, socket) {
            try {
                const { nodeId } = data.nodeParameters;

                if (!nodeId) {
                    console.error('Missing nodeId in deactivateNode request');
                    ipc.server.emit(socket, `callback:deactivateNode`, { success: false });
                    return;
                }

                // Clean up any resources for this node
                if (messageQueues[nodeId]) {
                    delete messageQueues[nodeId];
                }

                // Remove from settings if tracked
                if (settings.triggerNodes[nodeId]) {
                    delete settings.triggerNodes[nodeId];
                }

                ipc.server.emit(socket, `callback:deactivateNode`, {
                    success: true
                });
            } catch (error) {
                console.error('Error handling deactivateNode:', error);
                ipc.server.emit(socket, `callback:deactivateNode`, {
                    success: false,
                    error: error.message
                });
            }
        });

        // Handle cleanup bot request
        ipc.server.on('cleanupBot', function(data, socket) {
            try {
                const { nodeId, credentialHash } = data;

                if (!nodeId || !credentialHash) {
                    console.error('Missing required data for cleanupBot');
                    ipc.server.emit(socket, 'cleanupBot:response', { success: false });
                    return;
                }

                // Clean up resources for this node
                clearPlaceholder(nodeId);
                delete messageQueues[nodeId];

                // Remove from tracked nodes
                if (settings.triggerNodes[nodeId]) {
                    delete settings.triggerNodes[nodeId];
                    console.log(`Cleaned up node ${nodeId}`);
                }

                ipc.server.emit(socket, 'cleanupBot:response', { success: true });
            } catch (error) {
                console.error('Error in cleanupBot:', error);
                ipc.server.emit(socket, 'cleanupBot:response', { success: false });
            }
        });

        ipc.server.on('list:roles', function(data, socket) {
            try {
                const { guildIds, credentialHash } = data;
                if (!guildIds || !Array.isArray(guildIds) || !credentialHash) {
                    ipc.server.emit(socket, 'list:roles', []);
                    return;
                }

                const client = clients[credentialHash];

                if (!client) {
                    console.log(`No client found for credential hash ${credentialHash}`);
                    ipc.server.emit(socket, 'list:roles', []);
                    return;
                }

                const botInstance = settings.botInstances[credentialHash] as IBotInstance | undefined;
                if (!botInstance?.ready) {
                    console.log(`Bot instance not ready for ${credentialHash}`);
                    ipc.server.emit(socket, 'list:roles', []);
                    return;
                }

                const guilds = client.guilds.cache.filter(guild => guildIds.includes(`${guild.id}`));
                const rolesList: { name: string; value: string }[] = [];

                for (const guild of guilds.values()) {
                    const roles = guild.roles.cache;
                    for (const role of roles.values()) {
                        rolesList.push({
                            name: role.name,
                            value: role.id,
                        });
                    }
                }

                ipc.server.emit(socket, 'list:roles', rolesList);
            } catch (e) {
                console.error(`Error listing roles:`, e);
                ipc.server.emit(socket, 'list:roles', []);
            }
        });

        ipc.server.on('list:guilds', function(data, socket) {
            try {
                const { credentialHash } = data;
                if (!credentialHash) {
                    ipc.server.emit(socket, 'list:guilds', []);
                    return;
                }

                const client = clients[credentialHash];

                if (!client) {
                    console.log(`No client found for credential hash ${credentialHash}`);
                    ipc.server.emit(socket, 'list:guilds', []);
                    return;
                }

                const botInstance = settings.botInstances[credentialHash] as IBotInstance | undefined;
                if (!botInstance?.ready) {
                    console.log(`Bot instance not ready for ${credentialHash}`);
                    ipc.server.emit(socket, 'list:guilds', []);
                    return;
                }

                console.log('===== DEBUG: GUILD LISTING =====');
                console.log(`Client ready status: ${client.isReady()}`);
                console.log(`Client has guilds cache: ${Boolean(client.guilds.cache)}`);
                console.log(`Client guilds cache size: ${client.guilds.cache.size}`);
                console.log(`Client application ID: ${client.application?.id || 'unknown'}`);

                if (client.guilds.cache.size === 0) {
                    console.log('No guilds found in cache. Bot might not have the SERVER MEMBERS INTENT or hasn\'t been invited to any servers.');
                } else {
                    console.log('Guilds found:');
                    client.guilds.cache.forEach(guild => {
                        console.log(`- ${guild.name} (${guild.id})`);
                    });
                }
                console.log('===============================');

                const guildsList = client.guilds.cache.map((guild: Guild) => {
                    return {
                        name: guild.name,
                        value: guild.id,
                    };
                });

                ipc.server.emit(socket, 'list:guilds', guildsList);
            } catch (e) {
                console.error(`Error listing guilds:`, e);
                ipc.server.emit(socket, 'list:guilds', []);
            }
        });

        ipc.server.on('list:channels', function(data, socket) {
            try {
                const { guildIds, credentialHash } = data;
                if (!guildIds || !Array.isArray(guildIds) || !credentialHash) {
                    ipc.server.emit(socket, 'list:channels', []);
                    return;
                }

                const client = clients[credentialHash];

                if (!client) {
                    console.log(`No client found for credential hash ${credentialHash}`);
                    ipc.server.emit(socket, 'list:channels', []);
                    return;
                }

                const botInstance = settings.botInstances[credentialHash] as IBotInstance | undefined;
                if (!botInstance?.ready) {
                    console.log(`Bot instance not ready for ${credentialHash}`);
                    ipc.server.emit(socket, 'list:channels', []);
                    return;
                }

                const guilds = client.guilds.cache.filter(guild => guildIds.includes(`${guild.id}`));
                const channelsList: { name: string; value: string }[] = [];

                for (const guild of guilds.values()) {
                    const channels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildText);
                    for (const channel of channels.values()) {
                        channelsList.push({
                            name: channel.name,
                            value: channel.id,
                        });
                    }
                }

                ipc.server.emit(socket, 'list:channels', channelsList);
            } catch (e) {
                console.error(`Error listing channels:`, e);
                ipc.server.emit(socket, 'list:channels', []);
            }
        });

        ipc.server.on('credentials', function(data, socket) {
            try {
                const { credentials, credentialHash } = data;

                if (!credentials || !credentialHash) {
                    console.error('Missing credentials data');
                    ipc.server.emit(socket, 'credentials', 'error');
                    return;
                }

                console.log('===== DEBUG: CREDENTIALS HANDLER =====');
                console.log(`Received credentials with clientId: ${credentials.clientId?.substring(0, 5)}...`);
                console.log(`Has token: ${Boolean(credentials.token)}`);
                console.log(`Credential hash: ${credentialHash}`);
                console.log('===================================');

                // Check if we have this bot instance already
                const botInstance = settings.botInstances[credentialHash] as IBotInstance | undefined;

                // If the bot instance doesn't exist or has different credentials
                if (!botInstance?.ready ||
                    (botInstance.clientId !== credentials.clientId ||
                     botInstance.token !== credentials.token)) {

                    if (credentials.token && credentials.clientId) {
                        // Create or update bot instance in settings
                        if (!settings.botInstances[credentialHash]) {
                            settings.botInstances[credentialHash] = {
                                ready: false,
                                login: true,
                                clientId: credentials.clientId,
                                token: credentials.token,
                                baseUrl: credentials.baseUrl,
                                parameters: {}
                            };
                            console.log(`Created new bot instance for ${credentialHash}`);
                        } else {
                            (settings.botInstances[credentialHash] as IBotInstance).login = true;
                            console.log(`Updated existing bot instance for ${credentialHash}`);
                        }

                        // Destroy existing client if there is one
                        if (clients[credentialHash]) {
                            try {
                                clients[credentialHash].destroy();
                                console.log(`Destroyed existing client for ${credentialHash}`);
                            } catch (error) {
                                console.error(`Error destroying client:`, error);
                            }
                        }

                        // Create new client
                        const client = createNewClient(credentials);
                        clients[credentialHash] = client;

                        console.log('Attempting to login with provided token...');
                        client
                            .login(credentials.token)
                            .then(() => {
                                // set token for rest api as well
                                client.rest.setToken(credentials.token);

                                // Update bot instance status
                                const instance = settings.botInstances[credentialHash] as IBotInstance;
                                if (instance) {
                                    instance.ready = true;
                                    instance.login = false;
                                }

                                console.log(`Client login successful for ${credentialHash}: ${client.isReady()}`);
                                console.log(`Bot is in ${client.guilds.cache.size} servers/guilds`);
                                ipc.server.emit(socket, 'credentials', 'ready');

                                // Add to active connections
                                activeConnections.add(credentialHash);
                            })
                            .catch((e) => {
                                const instance = settings.botInstances[credentialHash] as IBotInstance;
                                if (instance) {
                                    instance.login = false;
                                }
                                console.error('Login failed with error:', e);
                                ipc.server.emit(socket, 'credentials', 'error');
                            });
                    } else {
                        ipc.server.emit(socket, 'credentials', 'missing');
                        console.error(`Credentials missing for ${credentialHash}`);
                    }
                } else if (botInstance.login) {
                    ipc.server.emit(socket, 'credentials', 'login');
                    console.log(`Already logging in for ${credentialHash}`);
                } else {
                    ipc.server.emit(socket, 'credentials', 'already');
                    console.log(`Using existing login for ${credentialHash}`);

                    // Ensure this is marked as an active connection
                    activeConnections.add(credentialHash);
                }
            } catch (e) {
                console.error(`Credentials handler error:`, e);
                ipc.server.emit(socket, 'credentials', 'error');
            }
        });

        ipc.server.on('send:message', async function(data, socket) {
            try {
                const { nodeParameters, credentialHash } = data;

                if (!nodeParameters || !credentialHash) {
                    ipc.server.emit(socket, 'callback:send:message', false);
                    return;
                }

                const client = clients[credentialHash];
                const botInstance = settings.botInstances[credentialHash] as IBotInstance | undefined;

                if (!client || !botInstance?.ready) {
                    console.log(`Client not ready for send:message: ${credentialHash}`);
                    ipc.server.emit(socket, 'callback:send:message', false);
                    return;
                }

                // fetch channel
                const channel = client.channels.cache.get(nodeParameters.channelId) as TextChannel | undefined;
                if (!channel || !channel.isTextBased()) {
                    console.log(`Channel not found or not text: ${nodeParameters.channelId}`);
                    ipc.server.emit(socket, 'callback:send:message', false);
                    return;
                }

                const preparedMessage = prepareMessage(nodeParameters);

                // finally send the message and report back to the listener
                const message = await channel.send(preparedMessage);
                ipc.server.emit(socket, 'callback:send:message', {
                    channelId: channel.id,
                    messageId: message.id
                });
            } catch (e) {
                console.error(`Error sending message:`, e);
                ipc.server.emit(socket, 'callback:send:message', false);
            }
        });

        ipc.server.on('send:action', async function(data, socket) {
            try {
                const { nodeParameters, credentialHash } = data;

                if (!nodeParameters || !credentialHash) {
                    ipc.server.emit(socket, 'callback:send:action', false);
                    return;
                }

                const client = clients[credentialHash];
                const botInstance = settings.botInstances[credentialHash] as IBotInstance | undefined;

                if (!client || !botInstance?.ready) {
                    console.log(`Client not ready for send:action: ${credentialHash}`);
                    ipc.server.emit(socket, 'callback:send:action', false);
                    return;
                }

                const performAction = async () => {
                    // remove messages
                    if (nodeParameters.actionType === 'removeMessages') {
                        const channel = client.channels.cache.get(nodeParameters.channelId) as TextChannel | undefined;
                        if (!channel || !channel.isTextBased()) {
                            ipc.server.emit(socket, 'callback:send:action', false);
                            return;
                        }

                        await channel.bulkDelete(nodeParameters.removeMessagesNumber).catch((e) => {
                            console.error(`Error bulk deleting messages:`, e);
                        });
                    }

                    // add or remove roles
                    else if (['addRole', 'removeRole'].includes(nodeParameters.actionType)) {
                        const guild = client.guilds.cache.get(nodeParameters.guildId);
                        if (!guild) {
                            ipc.server.emit(socket, 'callback:send:action', false);
                            return;
                        }

                        try {
                            const user = await client.users.fetch(nodeParameters.userId as string);
                            const guildMember = await guild.members.fetch(user);
                            const roles = guildMember.roles;

                            // Split the roles that are set in the parameters into individual ones or initialize as empty if no roles are set.
                            const roleUpdateIds = (typeof nodeParameters.roleUpdateIds === 'string' ?
                                nodeParameters.roleUpdateIds.split(',') :
                                nodeParameters.roleUpdateIds) || [];

                            for (const roleId of roleUpdateIds) {
                                if (!roles.cache.has(roleId) && nodeParameters.actionType === 'addRole')
                                    await roles.add(roleId);
                                else if (roles.cache.has(roleId) && nodeParameters.actionType === 'removeRole')
                                    await roles.remove(roleId);
                            }
                        } catch (error) {
                            console.error(`Error managing roles:`, error);
                            throw error;
                        }
                    }
                };

                await performAction();
                console.log(`Action ${nodeParameters.actionType} completed`);

                ipc.server.emit(socket, 'callback:send:action', {
                    action: nodeParameters.actionType,
                });
            } catch (e) {
                console.error(`Error performing action:`, e);
                ipc.server.emit(socket, 'callback:send:action', false);
            }
        });

        ipc.server.on('send:confirmation', async function(data, socket) {
            try {
                const { nodeParameters, credentialHash } = data;

                if (!nodeParameters || !credentialHash) {
                    ipc.server.emit(socket, 'callback:send:confirmation', { confirmed: null, success: false });
                    return;
                }

                const client = clients[credentialHash];
                const botInstance = settings.botInstances[credentialHash] as IBotInstance | undefined;

                if (!client || !botInstance?.ready) {
                    console.log(`Client not ready for send:confirmation: ${credentialHash}`);
                    ipc.server.emit(socket, 'callback:send:confirmation', { confirmed: null, success: false });
                    return;
                }

                // fetch channel
                const channel = client.channels.cache.get(nodeParameters.channelId) as TextChannel | undefined;
                if (!channel || !channel.isTextBased()) {
                    console.log(`Channel not found or not text: ${nodeParameters.channelId}`);
                    ipc.server.emit(socket, 'callback:send:confirmation', { confirmed: null, success: false });
                    return;
                }

                let confirmationMessage: Message|null = null;
                // prepare embed messages, if they are set by the client
                const confirmed = await new Promise<boolean | null>(async resolve => {
                    const preparedMessage = prepareMessage(nodeParameters);

                    const collector = channel.createMessageComponentCollector({
                        max: 1, // The number of times a user can click on the button
                        time: 10000, // The amount of time the collector is valid for in milliseconds,
                    });
                    let isResolved = false;

                    // Fixed event handler signatures for Discord.js collectors
                    collector.on("collect", function(interaction: ButtonInteraction, collection: Collection<string, ButtonInteraction>) {
                        try {
                            if (interaction.customId === "yes") {
                                if (interaction.message.deletable) {
                                    interaction.message.delete().catch((error) => {
                                        console.error('Error deleting message after YES:', error);
                                    });
                                }
                                isResolved = true;
                                return resolve(true);
                            } else if (interaction.customId === "no") {
                                if (interaction.message.deletable) {
                                    interaction.message.delete().catch((error) => {
                                        console.error('Error deleting message after NO:', error);
                                    });
                                }
                                isResolved = true;
                                return resolve(false);
                            }

                            if (interaction.message.deletable) {
                                interaction.message.delete().catch((error) => {
                                    console.error('Error deleting message after interaction:', error);
                                });
                            }
                            isResolved = true;
                            resolve(null);
                        } catch (error) {
                            console.error('Error handling button interaction:', error);
                            isResolved = true;
                            resolve(null);
                        }
                    });

                    // Fixed event handler signature for Discord.js collector end event
                    collector.on("end", function(collected: Collection<string, ButtonInteraction>, reason: string) {
                        try {
                            if (!isResolved) {
                                resolve(null);
                            }
                            if (confirmationMessage && confirmationMessage.deletable) {
                                confirmationMessage.delete().catch((error) => {
                                    console.error('Error deleting confirmation message on collector end:', error);
                                });
                            }
                        } catch (error) {
                            console.error('Error in collector end handler:', error);
                        }
                    });

                    // Create the action row with buttons
                    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents([
                        new ButtonBuilder()
                            .setCustomId('yes')
                            .setLabel('Yes')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId('no')
                            .setLabel('No')
                            .setStyle(ButtonStyle.Danger),
                    ]);

                    // Add the action row to the message
                    preparedMessage.components = [actionRow];

                    try {
                        confirmationMessage = await channel.send(preparedMessage);
                    } catch (error) {
                        console.error("Failed to send confirmation message:", error);
                        resolve(null);
                    }
                });

                console.log(`Sending confirmation callback for node ${nodeParameters.nodeId}: ${String(confirmed)}`);
                ipc.server.emit(socket, 'callback:send:confirmation', {
                    confirmed: confirmed,
                    success: true
                });
            } catch (e) {
                console.error(`Error sending confirmation:`, e);
                ipc.server.emit(socket, 'callback:send:confirmation', { confirmed: null, success: false });
            }
        });

        ipc.server.on('cleanupBot', async function(data, socket) {
            try {
                const { credentialHash, nodeId } = data;

                if (!credentialHash || !nodeId) {
                    ipc.server.emit(socket, 'cleanupBot:response', {
                        success: false,
                        error: 'Missing required parameters'
                    });
                    return;
                }

                console.log(`Cleaning up node ${nodeId} with credential hash ${credentialHash}`);

                // Remove the node from settings
                if (nodeId && settings.triggerNodes[nodeId]) {
                    delete settings.triggerNodes[nodeId];
                    console.log(`Removed node ${nodeId} from settings`);
                }

                // Check if this was the last node using this credential hash
                const remainingNodes = Object.entries(settings.triggerNodes)
                    .filter(([_, data]) => (data as unknown as ITriggerNode).credHash === credentialHash)
                    .map(([id, _]) => id);

                console.log(`Remaining nodes for credential hash ${credentialHash}: ${remainingNodes.length}`);

                // If no nodes are using this bot instance anymore, clean it up
                if (remainingNodes.length === 0 && credentialHash) {
                    console.log(`No more nodes using credential hash ${credentialHash}, cleaning up client and bot instance`);

                    // Destroy the Discord.js client
                    if (clients[credentialHash]) {
                        try {
                            clients[credentialHash].destroy();
                            console.log(`Destroyed Discord client for ${credentialHash}`);
                            delete clients[credentialHash];
                        } catch (error) {
                            console.error(`Error destroying client:`, error);
                        }
                    }

                    // Remove bot instance
                    if (settings.botInstances[credentialHash]) {
                        delete settings.botInstances[credentialHash];
                        console.log(`Removed bot instance for ${credentialHash}`);
                    }

                    // Remove from active connections
                    activeConnections.delete(credentialHash);
                    console.log(`Removed ${credentialHash} from active connections`);
                    console.log(`Remaining active connections: ${activeConnections.size}`);
                }

                ipc.server.emit(socket, 'cleanupBot:response', {
                    success: true,
                    remainingNodesCount: remainingNodes.length
                });
            } catch (e) {
                console.error(`Error in cleanupBot:`, e);
                ipc.server.emit(socket, 'cleanupBot:response', {
                    success: false,
                    error: String(e)
                });
            }
        });

        // Add handler to clean up placeholders when workflow execution is done
        ipc.server.on('workflowExecutionFinished', function(data, socket) {
            try {
                const { nodeId } = data.nodeParameters;

                if (!nodeId) {
                    console.error('Missing nodeId in workflowExecutionFinished event');
                    return;
                }

                console.log(`Workflow execution finished for node ${nodeId}, cleaning up placeholder`);
                clearPlaceholder(nodeId);

                ipc.server.emit(socket, 'workflowExecutionFinished:response', {
                    success: true,
                    nodeId: nodeId
                });
            } catch (e) {
                console.error(`Error handling workflow execution finished:`, e);
                ipc.server.emit(socket, 'workflowExecutionFinished:response', {
                    success: false,
                    error: String(e)
                });
            }
        });

        // Add handler to get new messages from the queue
        ipc.server.on('getNewMessages', function(data, socket) {
            try {
                // Extract nodeId from nodeParameters to match the format in the rest of the codebase
                const nodeId = data.nodeParameters?.nodeId;

                if (!nodeId) {
                    console.error('Missing nodeId in getNewMessages event');
                    ipc.server.emit(socket, 'getNewMessages:response', {
                        success: false,
                        error: 'Missing nodeId'
                    });
                    return;
                }

                const messages = messageQueues[nodeId] || [];
                messageQueues[nodeId] = []; // Clear the queue after fetching

                ipc.server.emit(socket, 'getNewMessages:response', {
                    success: true,
                    messages: messages
                });
            } catch (e) {
                console.error(`Error handling getNewMessages:`, e);
                ipc.server.emit(socket, 'getNewMessages:response', {
                    success: false,
                    error: String(e)
                });
            }
        });

        // Add handler to update trigger node status
        ipc.server.on('updateTriggerNodeStatus', function(data, socket) {
            try {
                const { nodeId, active } = data;

                if (!nodeId || typeof active !== 'boolean') {
                    console.error('Missing nodeId or active status in updateTriggerNodeStatus event');
                    ipc.server.emit(socket, 'updateTriggerNodeStatus:response', {
                        success: false,
                        error: 'Missing nodeId or active status'
                    });
                    return;
                }

                if (settings.triggerNodes[nodeId]) {
                    settings.triggerNodes[nodeId].active = active;
                    console.log(`Updated trigger node ${nodeId} status to ${active}`);
                    ipc.server.emit(socket, 'updateTriggerNodeStatus:response', {
                        success: true,
                        nodeId: nodeId,
                        active: active
                    });
                } else {
                    console.error(`Trigger node ${nodeId} not found`);
                    ipc.server.emit(socket, 'updateTriggerNodeStatus:response', {
                        success: false,
                        error: `Trigger node ${nodeId} not found`
                    });
                }
            } catch (e) {
                console.error(`Error handling updateTriggerNodeStatus:`, e);
                ipc.server.emit(socket, 'updateTriggerNodeStatus:response', {
                    success: false,
                    error: String(e)
                });
            }
        });
    });

    ipc.server.start();
    console.log('IPC server started');
}

// Update Discord client properties for a specific bot instance
export const updateDiscordClientProperties = async (triggerNode: ITriggerNode) => {
    try {
        const credHash = triggerNode.credHash;
        if (!credHash) {
            // Skip if no credential hash is available
            return;
        }

        if (settings.botInstances[credHash]) {
            // We already have a bot instance for this credential, update the properties
            (settings.botInstances[credHash] as any).triggerNodes =
                (settings.botInstances[credHash] as any).triggerNodes || {};
            (settings.botInstances[credHash] as any).triggerNodes[triggerNode.parameters.id] = triggerNode;
        }
    } catch (e: any) {
        console.log(`Error updating Discord client properties: ${e.message}`);
    }
};

// Remove a Discord client
export const removeDiscordClient = async (triggerNode: ITriggerNode) => {
    try {
        const credHash = triggerNode.credHash;
        if (!credHash || !settings.botInstances[credHash]) {
            // No bot instance found for this credential
            return;
        }

        // Remove the trigger node from the bot instance
        if ((settings.botInstances[credHash] as any).triggerNodes?.[triggerNode.parameters.id]) {
            delete (settings.botInstances[credHash] as any).triggerNodes[triggerNode.parameters.id];
        }

        // Check if there are any trigger nodes left
        const triggerNodes = (settings.botInstances[credHash] as any).triggerNodes || {};
        if (Object.keys(triggerNodes).length === 0) {
            // No trigger nodes left, destroy the bot instance
            if ((settings.botInstances[credHash] as any).client) {
                (settings.botInstances[credHash] as any).client.destroy();
            }
            delete settings.botInstances[credHash];
        }
    } catch (e: any) {
        console.log(`Error removing Discord client: ${e.message}`);
    }
};

// Create a new bot instance for a credential hash
export async function createBotInstance(credHash: string, parameters: any = {}): Promise<IBotInstance> {
    try {
        // Check if there's already a bot instance for this credential
        if (settings.botInstances[credHash]) {
            return settings.botInstances[credHash] as IBotInstance;
        }

        // Create a new bot instance
        const newInstance: IBotInstance = {
            id: credHash,
            client: null!, // Will be initialized when credentials are provided
            triggerNodes: {},
            ready: false,
            login: false,
            clientId: '',
            token: '',
            baseUrl: '', // Add empty string as default value
            parameters: parameters
        };

        settings.botInstances[credHash] = newInstance;

        console.log(`Created new bot instance for ${credHash}`);
        return newInstance;
    } catch (error: any) {
        console.error(`Error creating bot instance: ${error}`);
        throw error;
    }
}

// Add a trigger node to the list of nodes for a specific bot instance
export function addTriggerNode(type: string, credHash: string, node: ITriggerNode, workflow: IWorkflow): void {
    try {
        // Make sure the node has all required properties
        if (!node.parameters) {
            node.parameters = {
                id: node.node.id,
                name: node.node.name,
                type: node.node.type
            };
        }
        // Update the node with credential hash
        node.credHash = credHash;
        node.credentialHash = credHash; // Add this to match settings.ts
        node.workflowId = workflow.id;

        // Ensure active property is set
        if (node.active === undefined) {
            node.active = false;
        }

        // Add or update the trigger node in settings (removed duplicate line)
        settings.triggerNodes[node.parameters.id] = node;

        // Also add it to the bot instance's trigger nodes
        if (settings.botInstances[credHash]) {
            if (!(settings.botInstances[credHash] as any).triggerNodes) {
                (settings.botInstances[credHash] as any).triggerNodes = {};
            }
            (settings.botInstances[credHash] as any).triggerNodes[node.parameters.id] = node;
        }

        console.log(`Added ${type} trigger node ${node.parameters.id} to bot instance ${credHash}`);
    } catch (error) {
        console.error(`Error adding trigger node: ${error}`);
        throw error;
    }
}

export async function registerMessage(credHash: string | undefined, node: ITriggerNode, workflow: IWorkflow): Promise<void> {
    try {
        if (!credHash) {
            throw new Error('Credential hash is undefined');
        }

        // Create bot instance if it doesn't exist
        if (!settings.botInstances[credHash]) {
            await createBotInstance(credHash, node.parameters);
        }

        // Add message trigger to the list
        addTriggerNode('message', credHash, node, workflow);

        // Log successful registration
        console.log(`Registered message trigger for workflow ${workflow.id}, node ${node.parameters.name}`);
    } catch (error) {
        console.error('Error registering message trigger:', error);
        throw error;
    }
}
