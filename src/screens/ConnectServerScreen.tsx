import Constants from 'expo-constants';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ApiError, API_ERROR_HELP, type Health } from '../core/api';
import { formatLocal } from '../core/dates';
import { formatPairingCode, manualPairing, parsePairingQr, QR_ERROR_MESSAGES, type PairingPayload } from '../core/qr';
import type { RootProps } from '../navigation/types';
import { requestSync } from '../services/processing';
import { checkConnection, completePairing, disconnect, getClient, probeServer, type PairStep } from '../services/server';
import { Banner, Button, Card, Chip, Divider, Field, Header, Loading, Row, Screen, Section, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { space } from '../ui/theme';
import { useConnection, useSettings } from '../ui/useSettings';

type Stage =
  | { k: 'idle' }
  | { k: 'probing'; payload: PairingPayload }
  | { k: 'confirm'; payload: PairingPayload; health: Health; skewMs: number }
  | { k: 'pairing'; payload: PairingPayload; step: PairStep }
  | { k: 'error'; title: string; body: string; payload?: PairingPayload };

function describe(e: unknown): { title: string; body: string } {
  if (e instanceof ApiError) {
    const titles: Record<string, string> = {
      offline: 'Server not reachable', timeout: 'Connection timed out', pairing: 'Pairing code rejected', wrong_server: 'Wrong server',
      rate_limited: 'Too many attempts', host_rejected: 'Address rejected by server', invalid_response: 'Not a Qivra server', insecure_url: 'Insecure address', revoked: 'Device revoked',
    };
    return { title: titles[e.kind] ?? 'Pairing failed', body: e.kind === 'pairing' ? e.message : `${API_ERROR_HELP[e.kind]}${e.message && e.message !== API_ERROR_HELP[e.kind] ? `\n${e.message}` : ''}` };
  }
  return { title: 'Pairing failed', body: (e as Error)?.message ?? String(e) };
}

export default function ConnectServerScreen({ navigation, route }: RootProps<'ConnectServer'>) {
  const { connection } = useConnection();
  const settings = useSettings();
  const tz = settings?.timezone ?? 'UTC';
  const [stage, setStage] = useState<Stage>({ k: 'idle' });
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [fieldErr, setFieldErr] = useState<{ url?: string; code?: string }>({});
  const [deviceName, setDeviceName] = useState(`${Constants.deviceName ?? 'Android phone'}`.slice(0, 60));
  const { busy, run } = useAction();
  const devices = useQuery(async () => {
    if (!connection) return null;
    const client = await getClient();
    try {
      return client ? (await client.devices()).devices : null;
    } catch {
      return null;
    }
  }, ['connection'], [connection?.deviceId]);

  const start = async (payload: PairingPayload) => {
    setStage({ k: 'probing', payload });
    try {
      const { health, clockSkewMs } = await probeServer(payload);
      setStage({ k: 'confirm', payload, health, skewMs: clockSkewMs });
    } catch (e) {
      setStage({ k: 'error', ...describe(e), payload });
    }
  };

  useEffect(() => {
    const raw = route.params?.scanned;
    if (!raw) return;
    navigation.setParams({ scanned: undefined });
    const parsed = parsePairingQr(raw, Date.now());
    if (!parsed.ok) setStage({ k: 'error', title: 'Invalid QR code', body: QR_ERROR_MESSAGES[parsed.error] });
    else void start(parsed.payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.scanned]);

  const manual = () => {
    const r = manualPairing(url, code);
    if (!r.ok) return setFieldErr({ [r.field]: r.message });
    setFieldErr({});
    void start(r.payload);
  };

  const pair = (payload: PairingPayload) => run(async () => {
    setStage({ k: 'pairing', payload, step: 'pairing' });
    try {
      await completePairing(payload, deviceName, (step) => setStage({ k: 'pairing', payload, step }));
      setStage({ k: 'idle' });
      await requestSync();
    } catch (e) {
      setStage({ k: 'error', ...describe(e), payload });
    }
  });

  if (connection) {
    const healthy = !connection.lastError;
    return (
      <Screen>
        <Header title="Connect to My Server" onBack={() => navigation.goBack()} />
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
            <Chip label={healthy ? 'Connected' : 'Connection problem'} tone={healthy ? 'accent' : 'danger'} icon={healthy ? 'checkmark-circle' : 'alert-circle'} />
          </View>
          <T v="subtitle" selectable>{connection.serverUrl}</T>
          <T v="small" color="textMuted">Server ID {connection.serverId}{connection.serverVersion ? ` · v${connection.serverVersion}` : ''}{connection.lanEnabled === false ? ' · localhost-only mode' : ''}</T>
          <T v="small" color="textMuted">This device: {connection.deviceName} ({connection.deviceId})</T>
          <T v="small" color="textMuted">Paired {formatLocal(connection.pairedAt, tz)}</T>
          <T v="small" color="textMuted">Last successful check: {connection.lastHealthAt ? formatLocal(connection.lastHealthAt, tz) : 'never'}</T>
          <T v="small" color="textMuted">AI on server: {connection.aiAvailable === null ? 'unknown' : connection.aiAvailable ? 'available' : 'not configured'}</T>
        </Card>
        {connection.lastError ? <Banner tone="danger" title="Last check failed" body={`${connection.lastError.message}\n(${formatLocal(connection.lastError.at, tz)})`} /> : null}
        {connection.lastError?.kind === 'revoked' ? <Banner tone="warning" title="This device was revoked" body="Disconnect, then pair again with a new code from the server." /> : null}
        {connection.cleartext ? <Banner tone="warning" title="Plain HTTP" body="Traffic to this server is not encrypted. Use it only on a network you trust (home Wi-Fi or your own VPN)." /> : null}
        <View style={{ gap: space.sm, marginTop: space.md }}>
          <Button title="Check connection now" icon="pulse-outline" loading={busy} onPress={() => void run(() => checkConnection())} />
          <Button kind="outline" title="Sync now" icon="sync-outline" onPress={() => void run(() => requestSync())} />
          <Button kind="outline" title="Disconnect" onPress={() => void run(async () => {
            if (await confirm('Disconnect?', 'Stops syncing. The credential is deleted from this phone, but stays valid on the server until revoked.', 'Disconnect')) await disconnect(false);
          })} />
          <Button kind="danger" title="Disconnect and revoke this device" onPress={() => void run(async () => {
            if (!(await confirm('Revoke this device?', 'The server will reject this device’s credential immediately. You can pair again later.', 'Revoke', true))) return;
            const r = await disconnect(true);
            if (!r.revokedOnServer) setStage({ k: 'error', title: 'Disconnected, but not revoked', body: 'The server was unreachable. Revoke this device on the laptop with: python -m qivra revoke <device id>' });
          })} />
        </View>
        <Section title="Devices paired with this server">
          {devices.data ? devices.data.map((d) => <Row key={d.id} icon="phone-portrait-outline" title={`${d.name}${d.id === connection.deviceId ? ' (this phone)' : ''}`} subtitle={`${d.revoked ? 'Revoked' : 'Active'} · last seen ${d.last_seen_at ? formatLocal(d.last_seen_at, tz) : '—'}`} />)
            : <T v="small" color="textMuted">Unavailable while the server is unreachable.</T>}
          <T v="caption" color="textFaint">Revoke other devices on the laptop: python -m qivra revoke &lt;device id&gt;</T>
        </Section>
        <Troubleshooting />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Connect to My Server" subtitle="Optional. Qivra works fully on this phone without a server." onBack={() => navigation.goBack()} />
      <Card>
        <T v="subtitle">On your laptop</T>
        <T v="small" color="textMuted" style={{ marginTop: 4 }}>1. Start the server (in superat/server):</T>
        <T v="mono" selectable>.venv/bin/python -m qivra serve --lan</T>
        <T v="small" color="textMuted" style={{ marginTop: 4 }}>2. It prints the real server URL, a one-time Access ID and a QR code (valid ~5 minutes). Press Enter there for a new one.</T>
        <T v="small" color="textMuted">3. Keep the phone on the same Wi-Fi, then scan or type the code below.</T>
      </Card>

      {stage.k === 'probing' ? <Card style={{ marginTop: space.md }}><T>Checking {stage.payload.serverUrl}…</T><Loading /></Card> : null}

      {stage.k === 'confirm' ? (
        <Card style={{ marginTop: space.md }}>
          <T v="subtitle">Connect to this server?</T>
          <T selectable style={{ marginTop: 4 }}>{stage.payload.serverUrl}</T>
          <T v="small" color="textMuted">Qivra server v{stage.health.version} · ID {stage.health.server_id}{stage.payload.serverId ? ' (matches the QR code)' : ''}</T>
          <T v="small" color="textMuted">Access ID {formatPairingCode(stage.payload.pairingId)}{stage.payload.expiresAt ? ` · expires ${formatLocal(stage.payload.expiresAt, tz, { timeStyle: 'short' })}` : ''}</T>
          {Math.abs(stage.skewMs) > 120_000 ? <Banner tone="warning" title="Clocks differ" body={`This phone's clock is ${Math.round(Math.abs(stage.skewMs) / 60000)} min off from the server. Expiry is checked with the server's clock.`} /> : null}
          {stage.payload.cleartext ? <Banner tone="warning" title="Unencrypted connection (HTTP)" body="Notes and metadata will travel unencrypted on this network. Only continue on a network you trust." /> : null}
          <Field label="Name this phone" value={deviceName} onChangeText={setDeviceName} maxLength={60} />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title="Pair" icon="link-outline" onPress={() => void pair(stage.payload)} loading={busy} />
            <Button kind="outline" title="Cancel" onPress={() => setStage({ k: 'idle' })} />
          </View>
        </Card>
      ) : null}

      {stage.k === 'pairing' ? (
        <Card style={{ marginTop: space.md }}>
          <T>{stage.step === 'pairing' ? 'Exchanging the one-time code…' : stage.step === 'verifying' ? 'Verifying the new device credential with the server…' : 'Connected.'}</T>
          <Loading />
        </Card>
      ) : null}

      {stage.k === 'error' ? (
        <Banner tone="danger" title={stage.title} body={stage.body} action={stage.payload ? <Button kind="outline" title="Try again" onPress={() => void start(stage.payload!)} /> : undefined} />
      ) : null}

      {stage.k === 'idle' || stage.k === 'error' ? (
        <>
          <Button title="Scan QR code" icon="qr-code-outline" onPress={() => navigation.navigate('QrScan')} style={{ marginTop: space.md }} accessibilityHint="Asks for camera permission" />
          <Section title="Or enter manually">
            <Field label="Server URL" value={url} onChangeText={setUrl} placeholder="http://192.168.1.20:5001" autoCapitalize="none" autoCorrect={false} keyboardType="url" error={fieldErr.url} help="Use the exact address printed by the server, including the port." />
            <Field label="Access ID" value={code} onChangeText={setCode} placeholder="ABCD-1234" autoCapitalize="characters" autoCorrect={false} maxLength={12} error={fieldErr.code} />
            <Button kind="outline" title="Continue" onPress={manual} disabled={!url.trim() || !code.trim()} />
          </Section>
        </>
      ) : null}
      <Divider />
      <Troubleshooting />
    </Screen>
  );
}

function Troubleshooting() {
  return (
    <Section title="Troubleshooting">
      <T v="small" color="textMuted">• Same laptop / emulator: the Android emulator reaches the laptop at http://10.0.2.2:&lt;port&gt; (server in default localhost mode). A USB phone can use “adb reverse tcp:5001 tcp:5001” and http://127.0.0.1:5001.</T>
      <T v="small" color="textMuted">• Same Wi-Fi: start with --lan and use the LAN URL it prints. If it times out, allow incoming connections for Python in the laptop firewall, and check the phone isn't on a guest network.</T>
      <T v="small" color="textMuted">• Different network: direct connections are not possible. Use a VPN you control (e.g. Tailscale) and start the server with --allow-host/--advertise-url for the VPN address. Never expose the server publicly.</T>
      <T v="small" color="textMuted">• Wrong port or “not a Qivra server”: the port changes if 5000 is busy — copy the URL the server prints.</T>
      <T v="small" color="textMuted">• Laptop IP changed: disconnect and pair again with the new URL.</T>
      <T v="small" color="textMuted">• Expired or used code: press Enter in the server terminal or run python -m qivra pair --port &lt;port&gt;.</T>
    </Section>
  );
}
