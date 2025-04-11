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
} from '../helper';
import settings from '../settings';

// we start the bot if we are in the main process
if (!process.send) bot();

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
        outputs: ['main'],
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
                return await getGuildsHelper(this).catch((e) => e) as { name: string; value: string }[];
            },
            async getChannels(): Promise<INodePropertyOptions[]> {
                // @ts-ignore
                const selectedGuilds = this.getNodeParameter('guildIds', []);
                if (!selectedGuilds.length) {
                    // @ts-ignore
                    throw new NodeOperationError('Please select at least one server before choosing channels.');
                }

                return await getChannelsHelper(this, selectedGuilds).catch((e) => e) as { name: string; value: string }[];
            },
            async getRoles(): Promise<INodePropertyOptions[]> {
                // @ts-ignore
                const selectedGuilds = this.getNodeParameter('guildIds', []);
                if (!selectedGuilds.length) {
                    // @ts-ignore
                    throw new NodeOperationError('Please select at least one server before choosing channels.');
                }
                

                return await getRolesHelper(this, selectedGuilds).catch((e) => e) as { name: string; value: string }[];
            },
        },
    };

    async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {

        const credentials = (await this.getCredentials('discordBotTriggerApi').catch((e) => e)) as any as ICredentials;

        if (!credentials?.token) {
            console.log("No token given.");
            
            return {};
        }

        await connection(credentials).catch((e) => e);

        ipc.connectTo('bot', () => {
            console.log('Connected to IPC server');

            const parameters: any = {};
            Object.keys(this.getNode().parameters).forEach((key) => {
                parameters[key] = this.getNodeParameter(key, '') as any;
            });

            console.log("registering ", this.getNode().id, "... ", parameters);
            
            ipc.of.bot.emit('triggerNodeRegistered', {
                parameters,
                active: this.getWorkflow().active,
                credentials,
                nodeId: this.getNode().id, // Unique to each node
            });

            ipc.of.bot.on('messageCreate', ({ message, author, nodeId, messageReference, referenceAuthor }: any) => {
                if( this.getNode().id === nodeId) {
                    
                    const messageCreateOptions = {
                        id: message.id,
                        content: message.content,
                        channelId: message.channelId,
                        authorId: author.id,
                        authorName: author.username,
                        timestamp: message.createdTimestamp,
                        listenValue: this.getNodeParameter('value', ''),
                        authorIsBot: author.bot || author.system,
                        referenceId: null,
                        referenceContent: null,
                        referenceAuthorId: null,
                        referenceAuthorName: null,
                        referenceTimestamp: null,
                        // Add attachment support
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
                    }

                    if(messageReference) {
                        messageCreateOptions.referenceId = messageReference.id;
                        messageCreateOptions.referenceContent = messageReference.content;
                        messageCreateOptions.referenceAuthorId = referenceAuthor.id;
                        messageCreateOptions.referenceAuthorName = referenceAuthor.username;
                        messageCreateOptions.referenceTimestamp = messageReference.createdTimestamp;
                    }

                    this.emit([
                        this.helpers.returnJsonArray(messageCreateOptions),
                    ]);
                }
            });
        });

        ipc.of.bot.on('disconnect', () => {
            console.error('Disconnected from IPC server');
        });

        // Return the cleanup function
        return {
            closeFunction: async () => {
                const credentials = (await this.getCredentials('discordBotTriggerApi').catch((e) => e)) as any as ICredentials;
                const isActive = await checkWorkflowStatus(credentials.baseUrl, credentials.apiKey, String(this.getWorkflow().id));

                // remove the node from being executed
                console.log("removing trigger node");
                
                delete settings.triggerNodes[this.getNode().id];

                // disable the node if the workflow is not activated, but keep it running if it was just the test node
                if (!isActive || this.getActivationMode() !== 'manual') {
                    console.log('Workflow stopped. Disconnecting bot...');
                    ipc.disconnect('bot');
                }
            },
        };
    }
}
