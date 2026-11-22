// GitHub OAuth device flow: no client secret, no redirect URI, no browser callback.
//
// The extension only needs the account identity (`read:user`), which is what the quota service
// verifies before it issues an API session. The user authorizes on github.com and the polling
// below picks up the token.

export interface DeviceCodeInfo {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export class DeviceFlowError extends Error {}

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** Ask GitHub for a user code; the user enters it at `verificationUri`. */
export async function requestDeviceCode(clientId: string, scope = 'read:user'): Promise<DeviceCodeInfo> {
  const response = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
  });
  const data = await readJson(response);
  if (!response.ok || typeof data.device_code !== 'string') {
    throw new DeviceFlowError(
      typeof data.error_description === 'string'
        ? data.error_description
        : `GitHub did not return a sign-in code (${response.status}).`,
    );
  }
  return {
    deviceCode: data.device_code,
    userCode: String(data.user_code),
    verificationUri: String(data.verification_uri),
    expiresIn: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
  };
}

/**
 * Poll until the user authorizes the app. `isCancelled` is checked between polls so the caller's
 * progress notification stays cancellable; a cancelled flow never stores a token.
 */
export async function pollForAccessToken(
  clientId: string,
  device: DeviceCodeInfo,
  isCancelled: () => boolean = () => false,
): Promise<string> {
  let interval = Math.max(1, device.interval);
  const deadline = Date.now() + device.expiresIn * 1000;
  while (Date.now() < deadline) {
    if (isCancelled()) {
      throw new DeviceFlowError('GitHub sign-in was cancelled.');
    }
    await delay(interval * 1000);
    if (isCancelled()) {
      throw new DeviceFlowError('GitHub sign-in was cancelled.');
    }
    const response = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: device.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });
    const data = await readJson(response);
    if (typeof data.access_token === 'string' && data.access_token.length > 0) {
      return data.access_token;
    }
    switch (data.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        // GitHub asks for at least five seconds more between polls.
        interval += 5;
        break;
      case 'expired_token':
        throw new DeviceFlowError('The GitHub sign-in code expired. Start again.');
      case 'access_denied':
        throw new DeviceFlowError('GitHub sign-in was denied.');
      default:
        throw new DeviceFlowError(
          typeof data.error_description === 'string'
            ? data.error_description
            : 'GitHub sign-in failed.',
        );
    }
  }
  throw new DeviceFlowError('The GitHub sign-in code expired. Start again.');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GitHub answers the device endpoints with JSON when it recognizes the request, and with HTML or
 * an empty body when it does not; treat both as "no fields" rather than a parse crash. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown;
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
