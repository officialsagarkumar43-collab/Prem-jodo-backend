import agoraTokenPkg from 'agora-token';
const { RtcTokenBuilder, RtcRole } = agoraTokenPkg;

/**
 * Generate Agora RTC Token for Voice / Video Calls
 * 
 * @param {Object} params
 * @param {string} params.channelName - Name of the channel / room (e.g. conversationId)
 * @param {string|number} [params.uid=0] - User ID (integer or 0 for auto-assign)
 * @param {string} [params.role='publisher'] - 'publisher' | 'subscriber'
 * @param {number} [params.expireTime=3600] - Token expiration in seconds (default 1 hour)
 * @returns {Object} { token, appId, channelName, uid, role, expiresAt }
 */
export const generateAgoraRtcToken = ({
  channelName,
  uid = 0,
  role = 'publisher',
  expireTime = 3600
}) => {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate || appId === 'your_agora_app_id') {
    console.warn('⚠️ [Agora] AGORA_APP_ID or AGORA_APP_CERTIFICATE is not configured in .env!');
  }

  if (!channelName) {
    throw new Error('Channel name is required for generating Agora token');
  }

  const rtcRole =
    role === 'subscriber' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;

  // Calculate privilege expiration time in seconds
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + Number(expireTime);

  let token = '';
  // Agora supports numeric UIDs or String User Accounts
  if (typeof uid === 'number') {
    token = RtcTokenBuilder.buildTokenWithUid(
      appId || 'dummy_app_id',
      appCertificate || 'dummy_app_cert',
      channelName.toString(),
      uid,
      rtcRole,
      expireTime,
      privilegeExpiredTs
    );
  } else {
    token = RtcTokenBuilder.buildTokenWithUserAccount(
      appId || 'dummy_app_id',
      appCertificate || 'dummy_app_cert',
      channelName.toString(),
      uid.toString(),
      rtcRole,
      expireTime,
      privilegeExpiredTs
    );
  }

  return {
    token,
    appId: appId || '',
    channelName: channelName.toString(),
    uid,
    role,
    expiresIn: expireTime,
    expiresAt: new Date(Date.now() + expireTime * 1000).toISOString()
  };
};
