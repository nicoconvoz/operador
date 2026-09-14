# Operador — the Android app

The dashboard on a phone, plus the two things a browser tab cannot do: it keeps
watching when it is closed, and it can stop the engine.

## What it is, and what it is not

**It is a shell around a URL.** The dashboard is a server that reads Postgres,
and no phone hosts that — so the app does not contain the system, it points at
it. This matters: an app that pretended to hold the data would leave you
staring at a cached screen during exactly the outage you needed to see.

What it adds on top of the web page:

| | |
|---|---|
| **Background watch** | A foreground service polls the alert log and raises a system notification for anything that is not routine — even with the app closed. |
| **The kill switch** | One button. It can stop the engine from opening new positions, and release that stop. It can never place an order. |
| **Catch-up, not push** | The phone reads from a cursor, so being asleep for six hours costs latency rather than the alerts. |

`info` alerts are deliberately **not** notified. They are in the feed and on the
dashboard. A phone that buzzes on every heartbeat is a phone whose
notifications get turned off — and then the death exit does not arrive either.

## Building

```bash
./build-apk.sh
```

Needs a **JDK between 17 and 21** and the Android SDK. The script finds both:
it searches `JAVA_HOME`, `~/.jdks`, Eclipse Adoptium, and Android Studio's
bundled runtime, and refuses to build rather than guessing. The newest JDK is
the wrong JDK — Gradle 8.14 does not even parse a JDK 25 version string, and
fails with the bare number as its entire error message.

The output is `android/operador-debug.apk`, signed with the debug key, which is
all a sideloaded personal app needs.

```bash
adb install -r android/operador-debug.apk
```

Or copy the APK to the phone and open it (Android will ask you to allow
installs from that source once).

## Pointing it at the engine

On first run it asks for two things:

- **Server address** — where the dashboard runs. During the paper phase that is
  your computer on the same Wi-Fi, e.g. `http://192.168.1.10:3100`. Later it is
  the Vercel URL. Changing it never needs a rebuild.
- **Control token** — optional, and only for the kill switch. It must match
  `OPERADOR_CONTROL_TOKEN` on the server and be at least 24 characters; the
  control endpoint refuses to work at all rather than accept something
  guessable. Leave it empty and the app is read-only.

### Trying it without a database

The engine's phone API needs Postgres. To exercise the app before that exists:

```bash
npx tsx src/runtime/demo-server.ts
```

It serves the same endpoints from an in-memory store, running the **real** read
models, the **real** authorisation and the **real** kill switch — so what it
proves about the app transfers. It invents an alert every 45 seconds, because
an alerting channel you cannot watch arrive is a channel you have not tested.
Point the app at `http://<your-ip>:3101`; the token is printed at startup.

## Battery, and the honest caveat

Android may delay a background app's work while the phone is in deep sleep. The
app's checks then stretch out — the alert still arrives, later. Settings has a
button that opens the system screen to exempt it from battery optimisation;
some manufacturers (Xiaomi, Huawei, Samsung) are aggressive enough that this is
not optional if you want the interval you configured.

The default is one check a minute. The engine only decides once every fifteen,
so there is nothing to gain from going faster.

## Cleartext HTTP

`network_security_config.xml` permits it, because a LAN address like
`192.168.1.10` cannot hold a certificate. The app only ever loads the one URL
its owner typed in, so the exposure is that URL and nothing else. Once the
dashboard is behind HTTPS, set `cleartextTrafficPermitted` to `false`.

Worth stating plainly: anything on your network that finds that address can
read your positions. It cannot trade — the dashboard has no write path — and it
cannot stop the engine without the token. But it can look.

## Dependencies

One: `androidx.appcompat`. No HTTP client, no JSON library, no coroutines —
`HttpURLConnection` and `org.json` ship with Android, and three libraries to
poll two endpoints would be more dependency than program.
