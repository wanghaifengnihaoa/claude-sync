/**
 * Secrets handling for claude-sync.
 * Supports keep (no-op) and strip (replace values with ***) modes.
 */

const STRIP_PLACEHOLDER = '***';

/**
 * Strip secret values from an object, replacing them with *** placeholders.
 * Preserves key structure — only values are replaced.
 */
export function stripSecrets(obj, type) {
  if (type === 'settings') {
    return stripSettingsSecrets(structuredClone(obj));
  }
  if (type === 'mcpServers') {
    return stripMcpServersSecrets(structuredClone(obj));
  }
  return obj;
}

function stripSettingsSecrets(settings) {
  if (settings.env && typeof settings.env === 'object') {
    for (const [key, value] of Object.entries(settings.env)) {
      if (isSecretKey(key)) {
        settings.env[key] = STRIP_PLACEHOLDER;
      }
    }
  }
  return settings;
}

function stripMcpServersSecrets(mcpServers) {
  for (const [, server] of Object.entries(mcpServers)) {
    if (server && server.config && typeof server.config === 'object') {
      for (const [key] of Object.entries(server.config)) {
        if (isSecretKey(key)) {
          server.config[key] = STRIP_PLACEHOLDER;
        }
      }
    }
  }
  return mcpServers;
}

function isSecretKey(key) {
  const upper = key.toUpperCase();
  return (
    upper.endsWith('_KEY') ||
    upper.endsWith('_TOKEN') ||
    upper.endsWith('_SECRET') ||
    upper.includes('API_KEY') ||
    upper.includes('AUTH_TOKEN')
  );
}

/**
 * Check if a value is the *** placeholder.
 */
export function isStripped(value) {
  return value === STRIP_PLACEHOLDER;
}

/**
 * Find all stripped secret fields in an object, returning their paths and values.
 * Used during pull to know which fields need user input.
 */
export function findSecretFields(obj, type) {
  const fields = [];

  if (type === 'settings') {
    if (obj.env && typeof obj.env === 'object') {
      for (const [key, value] of Object.entries(obj.env)) {
        if (isStripped(value)) {
          fields.push({ path: `env.${key}`, value });
        }
      }
    }
  }

  if (type === 'mcpServers') {
    for (const [serverName, server] of Object.entries(obj)) {
      if (server && server.config && typeof server.config === 'object') {
        for (const [key, value] of Object.entries(server.config)) {
          if (isStripped(value)) {
            fields.push({ path: `${serverName}.config.${key}`, value });
          }
        }
      }
    }
  }

  return fields;
}
