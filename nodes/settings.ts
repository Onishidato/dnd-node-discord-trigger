// Define a type for bot instance information
interface IBotInstance {
    ready: boolean;
    login: boolean;
    clientId: string;
    token: string;
    baseUrl: string;
    parameters: any;
}

const settings: {
    testMode: boolean;
    // Store bot instances by credential hash (unique identifier for each credential set)
    botInstances: {
        [credentialHash: string]: IBotInstance
    };
    // Store trigger nodes with their associated credential hash
    triggerNodes: {
        [nodeId: string]: {
            parameters: any;
            credentialHash: string;
        }
    };
} = {
    testMode: false,
    botInstances: {},
    triggerNodes: {},
}

// Helper function to create a unique hash for credentials
export const getCredentialHash = (clientId: string, token: string): string => {
    return `${clientId}_${token.substring(0, 8)}`;
};

export default settings;