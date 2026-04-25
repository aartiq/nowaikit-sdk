export class ServiceNowError extends Error {
    code;
    details;
    constructor(message, code, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'ServiceNowError';
    }
}
//# sourceMappingURL=errors.js.map