export class ConfigurationError extends Error {
  constructor(variable, requirement) {
    // Include the variable name, never its potentially secret value.
    super(`${variable} ${requirement}`);
    this.name = "ConfigurationError";
    this.code = "INVALID_ENVIRONMENT";
    this.variable = variable;
  }
}
