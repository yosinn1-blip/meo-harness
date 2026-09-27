import { sha256 } from '../../worker/self-service/crypto.mjs';
export async function pilotSettings(sub = 'alice') {
  return {
    SELF_PILOT_OWNER_SHA256: await sha256(sub),
    SELF_REGISTRATION_ENABLED: 'false',
    SELF_PROCESSING_ENABLED: 'false',
    SELF_MAX_ACTIVE_STORES: '1',
    SELF_MONTHLY_DRAFT_LIMIT: '0',
    SELF_MONTHLY_PUSH_LIMIT: '0',
  };
}
