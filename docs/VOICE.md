# Self-hosted voice calls

Naigi supports one-to-one audio calls in direct conversations and joinable voice rooms in spaces.
Both use a self-hosted [LiveKit](https://livekit.io/) server as the WebRTC relay. LiveKit is a
separate service; Naigi does not use a hosted voice provider.

## Create and join a voice room

After the host configures LiveKit, a space owner or member with channel-creation permission can open
**Space Settings → Rooms**, choose **Voice** as the room type, enter a name, and add the room. Select
the voice room and choose **Join voice room**. Other members with access can join the same room from
their browser. The full-width left navigation footer permanently shows your profile, microphone/output
selection, mute, deafen, and settings. Joining adds a connection-status and room/location panel above
the profile strip, with a disconnect button there instead of in the profile strip. These sidebar controls
remain available while browsing other rooms. Mute and deafen choices made before joining carry into
the next connection. The active room view also has audio controls, including audio unlock and leave.
Reloading the page returns this tab to its previous voice room after unlocking and reconnecting.
Temporary network disruptions first use LiveKit's reconnect flow; if that connection ends, Naigi retries
joining with bounded backoff once chat signaling is available. Leaving, locking the browser, or losing
room access clears the rejoin intent. Only opaque space/room IDs and mute/deafen choices are saved in
tab-scoped session storage, never participant names or media keys. Browser permissions and autoplay
rules still apply; audio playback may need the **Enable audio** button after a reload.
On narrow layouts the sidebar footer is available in the navigation drawer. Direct-call controls remain
in their matching conversation. Microphone permission is required.
The room view shows participant tiles and highlights the active speaker. If your browser blocks incoming
audio autoplay, choose **Enable audio**; the room status also reports microphone publication, remote audio,
and playback or encryption problems.

Use either set of microphone and speaker dropdowns to choose input and output devices. The selections
stay in sync and are reused for later connections. Device names are read from your browser and are not
sent to Naigi or LiveKit. Some browsers do not allow websites to select an audio output device; in that
case, change the output in your operating system.

Voice-room capacity is not capped by Naigi to a fixed participant count. LiveKit's deployment
configuration, host resources, and network determine how many participants can connect. Direct
one-to-one calls remain limited to two participants.

## Voice & audio preferences

Open **Settings → Voice & audio**, or use the footer gear to open it in a separate tab without leaving
your voice connection. These preferences are browser-local and apply to both rooms and
direct calls. Device names, input samples, and microphone-test audio are never sent to Naigi.

- **Push to talk:** choose a shortcut and hold it while the Naigi page is focused, or hold the in-call
  talk button (also available on touch screens). Typing, form controls, focus loss, and hidden tabs do
  not activate the shortcut. Manual microphone mute always wins. This is not an OS-wide hotkey.
- **Input volume:** 0–200%, applied before encryption; high gain can clip. Browser automatic gain
  control is disabled so this setting has predictable effect.
- **Output volume:** 0–100%. Right-click a participant tile, sidebar voice participant, or member row
  (or use Shift+F10) for **Mute for me** and per-user volume. User volume multiplies output volume;
  deafen and per-user mute take precedence. These controls do not mute someone for others.
- **Silence threshold:** activity-mode input below the selected dBFS level is gated locally, with a
  200 ms release hold to preserve word endings. Fully left disables the gate. PTT ignores this threshold.
- **Mic test:** displays the input meter and whether audio passes the selected gate. Listening is opt-in;
  use headphones to avoid feedback. No recording is saved. Stopping, leaving the view, hiding the tab,
  or the 60-second limit releases the microphone and audio resources.
- **Default devices:** remembered only on this browser, including changes from in-call selectors.
  Microphone permission may be needed to list names. Unsupported output selectors are disabled.

Audio processing requires Web Audio/AudioWorklet support and trusted HTTPS. PTT is initialized closed
before publishing a microphone, and processing is reinstalled after device changes. No adaptive bitrate
or continuous-transmission change is included.

## Configure the service

Deploy LiveKit on infrastructure you control and configure a trusted HTTPS/WSS endpoint for browser
clients. Open the media and TURN ports required by your LiveKit deployment and network topology;
consult the [LiveKit self-hosting documentation](https://docs.livekit.io/transport/self-hosting/).
The Naigi server must also be able to reach the LiveKit HTTP API at the configured endpoint.
Users must open Naigi over HTTPS from a trusted certificate. Plain HTTP on a remote LAN IP (for
example, `http://192.168.x.x:3001`) is not a secure browser context, so browsers block microphone
access and the encrypted-media worker. `http://localhost` is only suitable on the same device.

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
