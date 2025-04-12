import { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class DiscordBotTriggerApi implements ICredentialType {
	name = 'discordBotTriggerApi';
	displayName = 'Discord Bot Trigger API';
	documentationUrl = 'https://github.com/onishidato/n8n-node-discord-trigger';
	properties: INodeProperties[] = [
		{
			displayName: 'Client ID',
			name: 'clientId',
			description: 'The OAuth2 client ID of the Discord App',
			type: 'string',
			default: '',
		},
		{
			displayName: 'Bot Token',
			name: 'token',
			description: 'The bot token of the Discord App',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'n8n API key',
			name: 'apiKey',
			description: 'The API key of the n8n server',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			description: 'The API URL of the n8n instance',
			type: 'string',
			default: '',
			placeholder: 'https://n8n.example.com/api/v1',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bot {{$credentials.token}}',
			},
		},
	};
	
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://discord.com/api/v10/',
			url: '/users/@me/guilds',
		},
	};
}