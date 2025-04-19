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
import {
    connection,
    ICredentials,
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

            // Establish connection with proper error handling
            try {
                await connection(credentials);
                console.log(`Connection established for node ${nodeId}`);
            } catch (error) {
                console.error(`Connection error for node ${nodeId}:`, error);
                throw new NodeOperationError(this.getNode(), `Failed to connect to Discord bot: ${error.message}`);
            }

            // Set up the trigger functionality
            const setupTrigger = async () => {
                try {
                    // Store a reference to the ITriggerFunctions
                    const self = this;

                    // Get node parameters to send to the bot
                    const parameters: Record<string, any> = {};
                    Object.keys(this.getNode().parameters).forEach((key) => {
                        parameters[key] = this.getNodeParameter(key, '') as any;
                    });

                    // Add the node ID for tracking
                    parameters.id = nodeId;
                    parameters.name = this.getNode().name;

                    console.log(`Registering trigger node ${nodeId} with parameters:`, parameters);

                    // Create a dedicated connection for this node
                    const connectionId = `node_${nodeId}_${Date.now()}`;
                    DiscordTrigger.nodeConnections.set(nodeId, connectionId);

                    // Register this node with the bot using ipcRequest
                    const registrationResult = await ipcRequest('triggerNodeRegistered', {
                        ...parameters,
                        active: isWorkflowActive,
                        nodeId: nodeId
                    }, credentials);

                    if (!registrationResult || !registrationResult.success) {
                        console.error(`Failed to register trigger node ${nodeId}`);
                        throw new NodeOperationError(this.getNode(), `Failed to register trigger node ${nodeId}`);
                    }

                    console.log(`Successfully registered trigger node ${nodeId}`);

                    // Function to process incoming messages
                    const processMessage = async (message: any) => {
                        try {
                            // Only process messages intended for this node
                            if (message.nodeId !== nodeId) return;

                            console.log(`Processing message for node ${nodeId}`);

                            const { author, messageReference, referenceAuthor } = message.message;

                            // Check if any attachments are images
                            const messageData = message.message;
                            const attachments = messageData.attachments ? Array.from(messageData.attachments.values()) : [];

                            const imageAttachments = attachments.filter((attachment: any) => {
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

                            // Format image data for AI services
                            const geminiReadyImages = imageAttachments.map((attachment: any) => ({
                                url: attachment.url,
                                mimeType: attachment.contentType || detectMimeTypeFromFilename(attachment.name),
                                width: attachment.width,
                                height: attachment.height,
                                size: attachment.size
                            }));

                            // Prepare message data for workflow execution
                            const messageCreateOptions = {
                                id: messageData.id,
                                content: messageData.content,
                                processedContent: messageData.processedContent || messageData.content,
                                channelId: messageData.channelId,
                                authorId: author.id,
                                authorName: author.username,
                                timestamp: messageData.createdTimestamp,
                                listenValue: self.getNodeParameter('value', ''),
                                authorIsBot: author.bot || author.system,
                                referenceId: null,
                                referenceContent: null,
                                referenceAuthorId: null,
                                referenceAuthorName: null,
                                referenceTimestamp: null,
                                hasAttachments: attachments.length > 0,
                                attachments: attachments.map((attachment: any) => ({
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
                                })),
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
                                    console.error(`Error notifying bot about workflow completion:`, error);
                                }
                            }, 3000);
                        } catch (error) {
                            console.error(`Error processing message for node ${nodeId}:`, error);
                        }
                    };

                    // Store the message handler in the map
                    DiscordTrigger.messageHandlers.set(nodeId, processMessage);

                    // Function to poll for messages from the bot
                    const pollMessages = async () => {
                        if (!DiscordTrigger.messageHandlers.has(nodeId)) {
                            // Node was deregistered, stop polling
                            return;
                        }

                        try {
                            const messages = await ipcRequest('getNewMessages', { nodeId }, credentials);

                            if (messages && Array.isArray(messages) && messages.length > 0) {
                                console.log(`Received ${messages.length} new message(s) for node ${nodeId}`);

                                for (const message of messages) {
                                    const handler = DiscordTrigger.messageHandlers.get(nodeId);
                                    if (handler) {
                                        await handler(message);
                                    }
                                }
                            }

                            // Continue polling with a reasonable interval
                            setTimeout(pollMessages, 2000);
                        } catch (error) {
                            console.error(`Error polling messages for node ${nodeId}:`, error);
                            // Continue polling even if there was an error, but with a longer delay
                            setTimeout(pollMessages, 5000);
                        }
                    };

                    // Start polling for messages
                    pollMessages();

                    // Set up periodic workflow status checks
                    const checkStatus = async () => {
                        if (!DiscordTrigger.messageHandlers.has(nodeId)) {
                            // Node was deregistered, stop checking
                            return;
                        }

                        try {
                            // Only check if the node still exists in our tracking map
                            const isActive = self.getWorkflow().active;

                            await ipcRequest('updateTriggerNodeStatus', {
                                nodeId,
                                active: isActive
                            }, credentials);

                            // Continue checking with a reasonable interval
                            setTimeout(checkStatus, 30000); // Every 30 seconds
                        } catch (error) {
                            console.error(`Error updating workflow status for node ${nodeId}:`, error);
                            // Continue checking even if there was an error, but with a longer delay
                            setTimeout(checkStatus, 60000); // Every 60 seconds on error
                        }
                    };

                    // Start checking workflow status periodically
                    checkStatus();

                    // When in test mode, let user know we're waiting for real messages
                    if (this.getMode() === 'manual') {
                        console.log(`Node ${nodeId} is in test mode - waiting for real Discord messages that match your trigger pattern. Please send a message in Discord to test this node.`);
                    }
                } catch (error) {
                    console.error(`Error in setupTrigger for node ${nodeId}:`, error);
                    throw error;
                }
            };

            // Execute the setup
            await setupTrigger();

            // Return the cleanup function and manual trigger function
                return {
                    closeFunction: async () => {
                        try {
                            console.log(`Cleaning up trigger node ${nodeId}`);

                            // Remove the message handler
                            DiscordTrigger.messageHandlers.delete(nodeId);

                            // Clean up the connection ID
                            DiscordTrigger.nodeConnections.delete(nodeId);

                            // Notify the bot to clean up this node
                            await cleanupBot(nodeId, credentials);

                            // Deactivate the node
                            await ipcRequest('deactivateNode', { nodeId }, credentials);

                            console.log(`Cleanup completed for node ${nodeId}`);
                        } catch (error) {
                            console.error(`Error in trigger node cleanup for ${nodeId}:`, error);
                        }
                    },
                    manualTriggerFunction: async () => {
                        try {
                            console.log(`Manual trigger function called for node ${nodeId}`);
                            console.log('Waiting for a real message from Discord. Please send a Discord message that matches your trigger pattern.');

                            // When manually triggered, we just enable polling and wait for a real message
                            // The bot is already connected and will send messages to this node when they match the pattern
                            // No need to create mock messages

                            // We need to return a promise that resolves when a message is received
                            return new Promise<void>((resolve) => {
                                // Store the original message handler
                                const originalHandler = DiscordTrigger.messageHandlers.get(nodeId);

                                // Replace with a handler that will resolve the promise when a message is received
                                DiscordTrigger.messageHandlers.set(nodeId, async (message: any) => {
                                    // First, call the original handler to process the message
                                    if (originalHandler) {
                                        await originalHandler(message);
                                    }

                                    // Then resolve the promise to continue the workflow
                                    resolve();

                                    // Now restore the original handler for future messages if it exists
                                    if (originalHandler) {
                                        DiscordTrigger.messageHandlers.set(nodeId, originalHandler);
                                    }
                                });

                                // Set a timeout in case no message is received
                                setTimeout(() => {
                                    // Restore the original handler if it exists
                                    if (originalHandler) {
                                        DiscordTrigger.messageHandlers.set(nodeId, originalHandler);
                                    }
                                    // Resolve without a value to match Promise<void> return type
                                    resolve();
                                }, 60000);
                            });
                        } catch (error) {
                            console.error(`Error in manual trigger for node ${nodeId}:`, error);
                            throw error;
                        }
                    }
                }
            } catch (error) {
                console.error(`Error in trigger function:`, error);
                throw error;
            }
    }
}
