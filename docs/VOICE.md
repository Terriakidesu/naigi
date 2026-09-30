# Self-hosted voice calls

Naigi supports one-to-one audio calls in direct conversations and joinable voice rooms in spaces.
Both use a self-hosted [LiveKit](https://livekit.io/) server as the WebRTC relay. LiveKit is a
separate service; Naigi does not use a hosted voice provider.

## Create and join a voice room

After the host configures LiveKit, a space owner or member with channel-creation permission can open
**Space Settings → Rooms**, choose **Voice** as the room type, enter a name, and add the room. Select
the voice room and choose **Join voice room**. Other members with access can join the same room from
their browser. A non-blocking in-call dock keeps the rest of Naigi usable and shows the current roster;
controls can mute your microphone, deafen incoming room audio, or leave. Microphone permission is required.

Voice-room capacity is not capped by Naigi to a fixed participant count. LiveKit's deployment
configuration, host resources, and network determine how many participants can connect. Direct
one-to-one calls remain limited to two participants.

## Configure the service

Deploy LiveKit on infrastructure you control and configure a trusted HTTPS/WSS endpoint for browser
clients. Open the media and TURN ports required by your LiveKit deployment and network topology;
consult the [LiveKit self-hosting documentation](https://docs.livekit.io/transport/self-hosting/).
The Naigi server must also be able to reach the LiveKit HTTP API at the configured endpoint.

Create a dedicated LiveKit API key and secret, then set all three variables in Naigi's `.env`:

```dotenv
LIVEKIT_URL=wss://voice.example.com
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret
```

Use `ws://localhost:7880` only for local development. Production requires WSS. Keep the API secret
on the Naigi server; it is used to create rooms and mint short-lived, microphone-only access tokens.
It is never sent to browsers. Direct-call rooms are capped at two participants; voice rooms leave
the participant limit to the LiveKit deployment. Restart Naigi after changing these values. If any
value is missing, voice remains unavailable and the rest of chat continues to work. Token requests
are rate-limited to 12 per account per minute; Redis must be available when issuing a voice token.

## Encryption and trust boundary

- Call invitations, dismissals, and end signals are encrypted inside the existing direct-message
  conversation before being sent over Naigi's realtime service. Redis receives ciphertext only.
- Voice-room join requests and media keys are encrypted inside the voice channel's conversation.
  The LiveKit token endpoint does not return the media key, and the relay never receives it.
- The mapping between random LiveKit participant identities and conversation members is exchanged
  only inside encrypted voice-room signals. Names and user identities are not sent to LiveKit.
- The call media key is generated in the caller's browser and shared only inside that encrypted
  invitation. It is not returned by the token API, stored on the server, or sent to LiveKit.
- The LiveKit browser SDK encrypts audio frames before they leave the client. The LiveKit server
  forwards encrypted frames and cannot decrypt them. Naigi refuses to connect if the browser SDK
  cannot enable its media-encryption worker; it does not fall back to unencrypted audio.
- Naigi validates active direct-conversation membership or voice-channel access and account
  suspensions before issuing a token and periodically during the session. Access loss or repeated
  authorization-check failures ends the local connection.
- LiveKit still learns connection metadata such as participant IP addresses, room timing, and
  encrypted traffic volume. A TURN relay can hide participant IP addresses from one another, but
  not from the LiveKit host. The LiveKit and Naigi operators remain able to observe their respective
  service metadata.

Calls require a browser with WebRTC, microphone permission, Web Crypto, and the LiveKit E2EE worker
features. The host's network/firewall and TURN configuration affect whether participants can connect.
Adaptive bitrate and host-tuned quality controls are not yet available.
