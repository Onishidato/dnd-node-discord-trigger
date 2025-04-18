# n8n Discord Trigger Node

A powerful n8n node that triggers workflows based on Discord messages and interactions, providing seamless integration between Discord and n8n's automation capabilities.

![Discord Trigger Node](./nodes/DiscordTrigger/discord-logo.svg)

## Features

### Discord Trigger Node
- **Multiple Discord Servers**: Connect to multiple Discord servers simultaneously
- **Channel Filtering**: Listen to specific channels or all channels in selected servers
- **Role-Based Filtering**: Trigger workflows only for users with specific roles
- **Flexible Message Matching**: Multiple pattern matching options:
  - Bot Mention: Trigger when the bot is @mentioned
  - Contains: Match text anywhere in the message
  - Contains Image: Detect when messages include image attachments (perfect for AI image analysis)
  - Ends With: Match text at the end of messages
  - Equals: Exact message matching
  - Every: Trigger on all messages
  - Regex: Advanced pattern matching with regular expressions
  - Starts With: Match text at the beginning of messages
- **Case Sensitivity**: Toggle between case-sensitive and case-insensitive matching
- **Reply Detection**: Option to trigger only on message replies
- **Placeholder Messages**: Display a message with animated dots while the workflow is running
- **Bot Interaction**: Respond in the triggering channel
- **External Bot Support**: Option to trigger on messages from other bots
- **Image Processing Support**: Built-in formatting for Google Gemini or other AI image processing services
- **Reference Message Access**: Access both the triggering message and any referenced messages

### Discord Interaction Node
The package also includes a Discord Interaction node for handling button clicks and selections.

## Most Useful Features

- **Placeholder Messages**: Provides immediate visual feedback in Discord that the workflow is processing
- **Multiple Pattern Matching Options**: Flexible ways to trigger workflows based on different message formats
- **Image Detection & Processing**: Built-in support for triggering on images and formatting for AI processing
- **Server & Channel Filtering**: Precise control over which messages trigger workflows
- **Bot Mention Detection**: Natural way for users to interact with the bot by mentioning it

## Installation

### Prerequisites
- Node.js >= 18.10
- n8n instance
- Discord bot token with proper permissions

### Using npm
```bash
npm install @onishidato/n8n-nodes-dnd-discord-trigger
```

### Using pnpm (recommended)
```bash
pnpm add @onishidato/n8n-nodes-dnd-discord-trigger
```

### Manual Installation
1. Download the latest release from the [GitHub repository](https://github.com/onishidato/n8n-dnd-discord-trigger)
2. Extract to your n8n custom nodes directory
3. Restart n8n

## Compatibility

This trigger node works with:
- n8n versions compatible with n8n-nodes-api-version 1
- Discord.js v14
- Node.js >= 18.10

## Current Limitations

- **Continuous Connection**: The Discord bot must maintain a constant connection to Discord, which may impact system resources
- **Token Security**: Your Discord bot token needs to be stored in n8n credentials
- **Webhook Alternative**: For simple use cases, Discord's native webhooks might be more efficient
- **Message Editing**: Currently doesn't support triggering on message edits
- **Rate Limiting**: Subject to Discord's API rate limits
- **IPC Communication**: Uses node-ipc for communication, which may have compatibility issues in some environments
- **Limited Thread Support**: Basic support for thread channels
- **Platform Dependency**: Windows and Unix-like systems have slightly different connection methods

## Setup Instructions

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give your bot a name
3. Go to the "Bot" tab and click "Add Bot"
4. Under "Privileged Gateway Intents", enable:
   - Presence Intent
   - Server Members Intent
   - Message Content Intent
5. Save changes
6. Copy your bot token (you'll need this for n8n)
7. Go to the "OAuth2" tab, then "URL Generator"
8. Select scopes: `bot` and `applications.commands`
9. Select bot permissions:
   - Read Messages/View Channels
   - Send Messages
   - Read Message History
   - Use Slash Commands
   - Add Reactions
10. Copy the generated URL and open it in your browser to add the bot to your server

### 2. Configure in n8n

1. In your n8n instance, create a new workflow
2. Add a "Discord Trigger" node
3. Create new credentials:
   - Client ID: Your Discord application client ID
   - Bot Token: Your Discord bot token
   - Base URL (optional): Your n8n instance URL for advanced features
   - API Key (optional): Your n8n API key for workflow status checks
4. Configure the trigger node:
   - Select server(s)
   - Select channel(s) (optional)
   - Select role(s) (optional)
   - Choose a pattern type and value
   - Configure additional options as needed
   - Add a placeholder message (optional)
5. Save and activate your workflow

### 3. Using the Placeholder Feature

1. In the Discord Trigger node settings, add a message to the "Placeholder" field
2. When triggered, this message will appear in the Discord channel with animated dots
3. When the workflow execution completes (about 3 seconds later), the placeholder will be automatically removed
4. Use this to provide visual feedback to users that their request is being processed

## Example Use Cases

- Create a support ticket system in Discord
- Generate AI responses to user queries
- Process and analyze images posted in Discord
- Create moderation tools that respond to specific commands
- Build interactive dashboards with buttons and selections
- Track server activity and create reports
- Create automated responses based on specific keywords
- Build a knowledge base that responds to questions

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Author

Created by [onishidato](https://github.com/onishidato)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
