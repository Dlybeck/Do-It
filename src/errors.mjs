// An error whose message is meant for the person calling a tool. Anything else is
// reported as "Internal error." and logged.
export class UserError extends Error {}
