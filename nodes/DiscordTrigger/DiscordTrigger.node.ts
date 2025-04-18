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
import ipc from 'node-ipc';
import {
    connection,
    ICredentials,
    checkWorkflowStatus,
    getChannels as getChannelsHelper,
    getRoles as getRolesHelper,
    getGuilds as getGuildsHelper,
    cleanupBot,
} from '../helper';
import { getCredentialHash } from '../settings';

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
                    if (!selectedGuilds.length) {
                        // @ts-ignore
                        throw new NodeOperationError(this.getNode(), 'Please select at least one server before choosing roles.');
                    }

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
            const credentialHash = getCredentialHash(credentials.clientId, credentials.token);

            // Establish connection with proper error handling
            try {
                await connection(credentials);
                console.log(`Connection established for node ${nodeId}`);
            } catch (error) {
                console.error(`Connection error for node ${nodeId}:`, error);
                throw new NodeOperationError(this.getNode(), `Failed to connect to Discord bot: ${error.message}`);
            }

            // Set up message listener for this trigger node
            const setupMessageListener = () => {
                return new Promise<void>((resolve) => {
                    // Store a reference to the ITriggerFunctions
                    const self = this;

                    // Get node parameters to send to the bot
                    const parameters: Record<string, any> = {};
                    Object.keys(this.getNode().parameters).forEach((key) => {
                        parameters[key] = this.getNodeParameter(key, '') as any;
                    });

                    console.log(`Registering trigger node ${nodeId} with parameters:`, parameters);

                    // First check if there's an existing handler for this node and remove it
                    if (DiscordTrigger.messageHandlers.has(nodeId)) {
                        try {
                            const oldHandler = DiscordTrigger.messageHandlers.get(nodeId);
                            if (oldHandler && ipc.of && ipc.of.bot) {
                                ipc.of.bot.off('messageCreate', oldHandler);
                                console.log(`Removed previous message handler for node ${nodeId}`);
                            }
                        } catch (error) {
                            console.error(`Error removing previous message handler for node ${nodeId}:`, error);
                        }
                    }

                    // Register this node with the bot, including its active status
                    ipc.of.bot.emit('triggerNodeRegistered', {
                        parameters,
                        active: isWorkflowActive,
                        credentialHash: credentialHash,
                        nodeId: nodeId,
                    });

                    // Create new message handler function
                    const messageHandler = function(this: any, { message, author, nodeId: msgNodeId, messageReference, referenceAuthor }: any) {
                        // Only process messages intended for this node
                        if (msgNodeId !== nodeId) return;

                        // Debug logging
                        console.log(`Received message for node ${msgNodeId}`);

                        // Check if any attachments are images
                        const imageAttachments = message.attachments ? Array.from(message.attachments.values()).filter((attachment: any) => {
                            const contentType = attachment.contentType?.toLowerCase() || '';
                            return contentType.startsWith('image/');
                        }) : [];

                        // Format image data for AI services
                        const geminiReadyImages = imageAttachments.map((attachment: any) => ({
                            url: attachment.url,
                            mimeType: attachment.contentType,
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
                        // Use setTimeout to give the workflow time to start processing before notifying completion
                        setTimeout(() => {
                            if (ipc.of && ipc.of.bot) {
                                try {
                                    // Notify bot that workflow execution finished to clean up the placeholder
                                    ipc.of.bot.emit('workflowExecutionFinished', {
                                        nodeId: nodeId
                                    });
                                } catch (error) {
                                    console.error(`Error notifying bot about workflow completion for node ${nodeId}:`, error);
                                }
                            }
                        }, 3000); // Wait 3 seconds before cleaning up placeholder to let workflow execute
                    };

                    // Store the new handler in our map
                    DiscordTrigger.messageHandlers.set(nodeId, messageHandler);

                    // Set up message handler for this node
                    ipc.of.bot.on('messageCreate', messageHandler);

                    // Set up a listener for workflow status changes
                    const updateWorkflowActive = async () => {
                        try {
                            // Check if the workflow is still active directly from n8n API
                            const isActive = await checkWorkflowStatus(
                                credentials.baseUrl,
                                credentials.apiKey,
                                String(self.getWorkflow().id)
                            );

                            // If status changed, update it in the bot
                            ipc.of.bot.emit('triggerNodeRegistered', {
                                parameters,
                                active: isActive,
                                credentialHash: credentialHash,
                                nodeId: nodeId,
                            });

                            console.log(`Updated workflow active status for node ${nodeId}: ${isActive}`);

                            // Schedule another check after a delay
                            setTimeout(updateWorkflowActive, 30000); // Check every 30 seconds
                        } catch (error) {
                            console.error(`Error checking workflow status for node ${nodeId}:`, error);
                        }
                    };

                    // Start periodic workflow status checks
                    updateWorkflowActive();

                    // Handle connection errors and disconnects
                    ipc.of.bot.on('error', function(this: any, err: any) {
                        console.error(`IPC error in node ${nodeId}:`, err);
                    });

                    resolve();
                });
            };

            // Set up the message listener
            await setupMessageListener();

            // Return the cleanup function
            return {
                closeFunction: async () => {
                    try {
                        console.log(`Cleaning up trigger node ${nodeId}`);

                        // Remove the message handler from our map and from ipc
                        if (DiscordTrigger.messageHandlers.has(nodeId)) {
                            const handler = DiscordTrigger.messageHandlers.get(nodeId);
                            if (handler && ipc.of && ipc.of.bot) {
                                ipc.of.bot.off('messageCreate', handler);
                            }
                            DiscordTrigger.messageHandlers.delete(nodeId);
                            console.log(`Removed message handler for node ${nodeId}`);
                        }

                        // Check if the workflow is still active
                        let isActive = false;
                        try {
                            isActive = await checkWorkflowStatus(
                                credentials.baseUrl,
                                credentials.apiKey,
                                String(this.getWorkflow().id)
                            );
                        } catch (error) {
                            console.error('Error checking workflow status:', error);
                            // Assume not active if we can't check
                            isActive = false;
                        }

                        // Update the node's active status in the bot
                        ipc.of.bot.emit('triggerNodeRegistered', {
                            parameters: {},
                            active: false, // Always set to false when cleaning up
                            credentialHash: credentialHash,
                            nodeId: nodeId,
                        });

                        // Clean up this node with the bot
                        await cleanupBot(nodeId, credentials);

                        // Only disconnect if the workflow is not active anymore or if this is a manual test
                        if (!isActive || this.getActivationMode() === 'manual') {
                            console.log(`Workflow ${this.getWorkflow().id} is no longer active or was a manual test. Disconnecting.`);

                            try {
                                // Disconnect from the IPC server
                                ipc.disconnect('bot');
                                console.log(`Disconnected from IPC server for node ${nodeId}`);
                            } catch (error) {
                                console.error('Error disconnecting from IPC server:', error);
                            }
                        }
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
