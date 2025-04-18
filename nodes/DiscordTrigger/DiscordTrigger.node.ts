import {
    type INodeType,
    type INodeTypeDescription,
    type ITriggerFunctions,
    type ITriggerResponse,
    type INodePropertyOptions,
    NodeOperationError,
    NodeConnectionType,
} from 'n8n-workflow';
import { options } from './DiscordTrigger.node.options';
import bot from '../bot';
import { detectMimeTypeFromFilename } from '../helper';
import ipc from 'node-ipc';
import {
    connection,
    ICredentials,
    checkWorkflowStatus,
    getChannels as getChannelsHelper,
    getRoles as getRolesHelper,
    getGuilds as getGuildsHelper,
    cleanupBot,
    ipcRequest,
} from '../helper';
// import { getCredentialHash } from '../settings';

// Only start the bot in the main process
if (!process.send) {
    console.log('Starting bot in main process...');
    bot();
}

export class DiscordTrigger implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'Discord Trigger',
        name: 'discordTrigger',
        group: ['trigger', 'discord'],
        version: 1,
        description: 'Discord Trigger on message',
        defaults: {
            name: 'Discord Trigger',
        },
        icon: 'file:discord-logo.svg',
        inputs: [],
        outputs: ['main'] as NodeConnectionType[],
        credentials: [
            {
                name: 'discordBotTriggerApi',
                required: true,
            },
        ],
        properties: options,
    };

    methods = {
        loadOptions: {
            async getGuilds(): Promise<INodePropertyOptions[]> {
                try {
                    return await getGuildsHelper(this);
                } catch (error) {
                    console.error('Error loading guilds:', error);
                    return [{ name: `Error: ${error.message}`, value: 'false' }];
                }
            },
            async getChannels(): Promise<INodePropertyOptions[]> {
                try {
                    // @ts-ignore
                    const selectedGuilds = this.getNodeParameter('guildIds', []);
                    if (!selectedGuilds.length) {
                        // @ts-ignore
                        throw new NodeOperationError(this.getNode(), 'Please select at least one server before choosing channels.');
                    }

                    return await getChannelsHelper(this, selectedGuilds);
                } catch (error) {
                    console.error('Error loading channels:', error);
                    return [{ name: `Error: ${error.message}`, value: 'false' }];
                }
            },
            async getRoles(): Promise<INodePropertyOptions[]> {
                try {
                    // @ts-ignore
                    const selectedGuilds = this.getNodeParameter('guildIds', []);
                    // Instead of throwing an error, just pass the empty array to the helper
                    // The helper will handle the case properly
                    return await getRolesHelper(this, selectedGuilds);
                } catch (error) {
                    console.error('Error loading roles:', error);
                    return [{ name: `Error: ${error.message}`, value: 'false' }];
                }
            },
        },
    };

    // Map to keep track of active message handlers for each node
    private static messageHandlers: Map<string, Function> = new Map();

    // Store connection ID for each node
    private static nodeConnections: Map<string, string> = new Map();

    async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
        try {
            const credentials = await this.getCredentials('discordBotTriggerApi') as unknown as ICredentials;

            if (!credentials?.token) {
                console.log("No token given.");
                throw new NodeOperationError(this.getNode(), "Discord bot token is required");
            }

            const nodeId = this.getNode().id;
            const isWorkflowActive = this.getWorkflow().active;

            // Generate credential hash from bot token and client ID
            // const credentialHash = getCredentialHash(credentials.clientId, credentials.token);

            // Establish connection with proper error handling
            try {
                await connection(credentials);
                console.log(`Connection established for node ${nodeId}`);
            } catch (error) {
                console.error(`Connection error for node ${nodeId}:`, error);
                throw new NodeOperationError(this.getNode(), `Failed to connect to Discord bot: ${error.message}`);
            }

            // Set up message listener for this trigger node
            const setupMessageListener = async () => {
                return new Promise<void>(async (resolve, reject) => {
                    try {
                        // Store a reference to the ITriggerFunctions
                        const self = this;

                        // Get node parameters to send to the bot
                        const parameters: Record<string, any> = {};
                        Object.keys(this.getNode().parameters).forEach((key) => {
                            parameters[key] = this.getNodeParameter(key, '') as any;
                        });

                        console.log(`Registering trigger node ${nodeId} with parameters:`, parameters);

                        // Create a dedicated connection for this node with a unique ID
                        const connectionId = `node_${nodeId}_${Date.now()}`;
                        DiscordTrigger.nodeConnections.set(nodeId, connectionId);

                        // Initialize IPC
                        ipc.config.id = connectionId;
                        ipc.config.retry = 1500;
                        ipc.config.silent = false;

                        // Register this node with the bot using ipcRequest
                        const registrationResult = await ipcRequest('triggerNodeRegistered', {
                            parameters,
                            active: isWorkflowActive,
                            nodeId: nodeId
                        }, credentials);

                        if (!registrationResult) {
                            console.error(`Failed to register trigger node ${nodeId}`);
                            reject(new Error(`Failed to register trigger node ${nodeId}`));
                            return;
                        }

                        // Create a function to handle incoming messages for this node
                        const handleMessage = async (message: any) => {
                            try {
                                // Only process messages intended for this node
                                if (message.nodeId !== nodeId) return;

                                // Debug logging
                                console.log(`Received message for node ${nodeId}`);

                                const { author, messageReference, referenceAuthor } = message;

                                // Check if any attachments are images
                                const imageAttachments = message.attachments ? Array.from(message.attachments.values()).filter((attachment: any) => {
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
                                }) : [];

                                // Format image data for AI services
                                const geminiReadyImages = imageAttachments.map((attachment: any) => ({
                                    url: attachment.url,
                                    mimeType: attachment.contentType || detectMimeTypeFromFilename(attachment.name),
                                    width: attachment.width,
                                    height: attachment.height,
                                    size: attachment.size
                                }));

                                // Prepare message data to emit
                                const messageCreateOptions = {
                                    id: message.id,
                                    content: message.content,
                                    processedContent: message.processedContent || message.content,
                                    channelId: message.channelId,
                                    authorId: author.id,
                                    authorName: author.username,
                                    timestamp: message.createdTimestamp,
                                    listenValue: self.getNodeParameter('value', ''),
                                    authorIsBot: author.bot || author.system,
                                    referenceId: null,
                                    referenceContent: null,
                                    referenceAuthorId: null,
                                    referenceAuthorName: null,
                                    referenceTimestamp: null,
                                    hasAttachments: message.attachments?.size > 0,
                                    attachments: message.attachments ? Array.from(message.attachments.values()).map((attachment: any) => ({
                                        id: attachment.id,
                                        url: attachment.url,
                                        proxyUrl: attachment.proxyURL,
                                        filename: attachment.name,
                                        contentType: attachment.contentType,
                                        size: attachment.size,
                                        width: attachment.width,
                                        height: attachment.height,
                                        description: attachment.description,
                                        ephemeral: attachment.ephemeral,
                                    })) : [],
                                    hasImages: imageAttachments.length > 0,
                                    imageCount: imageAttachments.length,
                                    geminiImages: geminiReadyImages,
                                    geminiPromptTemplate: imageAttachments.length > 0 ?
                                        "Analyze this image and describe what you see in detail." :
                                        "No images attached to analyze."
                                };

                                // Add reference message data if present
                                if (messageReference) {
                                    messageCreateOptions.referenceId = messageReference.id;
                                    messageCreateOptions.referenceContent = messageReference.content;
                                    messageCreateOptions.referenceAuthorId = referenceAuthor.id;
                                    messageCreateOptions.referenceAuthorName = referenceAuthor.username;
                                    messageCreateOptions.referenceTimestamp = messageReference.createdTimestamp;
                                }

                                // Emit message data to trigger workflow execution
                                self.emit([
                                    self.helpers.returnJsonArray(messageCreateOptions),
                                ]);

                                // Clean up placeholder when workflow execution finishes
                                // Notify workflow execution finished after a timeout
                                setTimeout(async () => {
                                    try {
                                        await ipcRequest('workflowExecutionFinished', { nodeId }, credentials);
                                    } catch (error) {
                                        console.error(`Error notifying bot about workflow completion for node ${nodeId}:`, error);
                                    }
                                }, 3000);
                            } catch (error) {
                                console.error(`Error processing message for node ${nodeId}:`, error);
                            }
                        };

                        // Store the message handler
                        DiscordTrigger.messageHandlers.set(nodeId, handleMessage);

                        // Set up a listener for messages using ipcRequest
                        // Use polling approach to check for new messages
                        const pollForMessages = async () => {
                            try {
                                // Only poll if node is still registered
                                if (DiscordTrigger.messageHandlers.has(nodeId)) {
                                    const handler = DiscordTrigger.messageHandlers.get(nodeId);

                                    // Request any new messages for this node
                                    const newMessages = await ipcRequest('getNewMessages', { nodeId }, credentials);

                                    // Process any new messages
                                    if (newMessages && Array.isArray(newMessages) && newMessages.length > 0) {
                                        for (const message of newMessages) {
                                            if (handler) {
                                                await handler(message);
                                            }
                                        }
                                    }

                                    // Poll again after a short delay
                                    setTimeout(pollForMessages, 2000); // Poll every 2 seconds
                                }
                            } catch (error) {
                                console.error(`Error polling for messages for node ${nodeId}:`, error);
                                // Continue polling even if there's an error
                                setTimeout(pollForMessages, 5000); // Back off on errors
                            }
                        };

                        // Start polling for messages
                        pollForMessages();

                        // Set up a function to update workflow status periodically
                        const updateWorkflowActive = async () => {
                            try {
                                // Only update if the node is still registered
                                if (DiscordTrigger.messageHandlers.has(nodeId)) {
                                    // Check if the workflow is still active
                                    const isActive = await checkWorkflowStatus(
                                        credentials.baseUrl,
                                        credentials.apiKey,
                                        String(self.getWorkflow().id)
                                    );

                                    // Update the node's active status in the bot
                                    await ipcRequest('updateTriggerNodeStatus', {
                                        nodeId,
                                        active: isActive
                                    }, credentials);

                                    // Schedule next update
                                    setTimeout(updateWorkflowActive, 30000); // Check every 30 seconds
                                }
                            } catch (error) {
                                console.error(`Error updating workflow status for node ${nodeId}:`, error);

                                // Continue checking even if there's an error
                                setTimeout(updateWorkflowActive, 60000); // Back off on errors
                            }
                        };

                        // Start periodic workflow status checks
                        updateWorkflowActive();

                        resolve();
                    } catch (error) {
                        console.error(`Error setting up message listener for node ${nodeId}:`, error);
                        reject(error);
                    }
                });
            };

            // Set up the message listener
            await setupMessageListener();

            // Return the cleanup function
            return {
                closeFunction: async () => {
                    try {
                        console.log(`Cleaning up trigger node ${nodeId}`);

                        // Clean up this node with the bot
                        await cleanupBot(nodeId, credentials);

                        // Remove the message handler from our map
                        if (DiscordTrigger.messageHandlers.has(nodeId)) {
                            DiscordTrigger.messageHandlers.delete(nodeId);
                            console.log(`Removed message handler for node ${nodeId}`);
                        }

                        // Clean up connection for this node
                        if (DiscordTrigger.nodeConnections.has(nodeId)) {
                            const connectionId = DiscordTrigger.nodeConnections.get(nodeId);
                            if (connectionId) {
                                try {
                                    ipc.disconnect(connectionId);
                                    console.log(`Disconnected IPC connection ${connectionId} for node ${nodeId}`);
                                } catch (error) {
                                    console.error(`Error disconnecting IPC connection for node ${nodeId}:`, error);
                                }
                            }
                            DiscordTrigger.nodeConnections.delete(nodeId);
                        }

                        // Notify the bot that this node is being deactivated
                        await ipcRequest('deactivateNode', { nodeId }, credentials);
                    } catch (error) {
                        console.error(`Error in trigger node cleanup for ${nodeId}:`, error);
                    }
                },
            };
        } catch (error) {
            console.error('Error in Discord Trigger setup:', error);
            throw error;
        }
    }
}
