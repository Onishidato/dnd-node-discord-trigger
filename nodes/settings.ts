const settings: {
    ready: boolean;
    login: boolean;
    testMode: boolean;
    clientId: string;
    token: string;
    baseUrl: string;
    parameters: any;

    triggerNodes: any;
} = {
    ready: false,
    login: false,
    testMode: false,
    clientId: '',
    token: '',
    baseUrl: '',
    parameters: {},

    triggerNodes: {},
}

export default settings;