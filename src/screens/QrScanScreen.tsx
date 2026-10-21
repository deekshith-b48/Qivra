import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import React, { useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { parsePairingQr, QR_ERROR_MESSAGES } from '../core/qr';
import type { RootProps } from '../navigation/types';
import { Banner, Button, Header, Loading, Screen, T } from '../ui/components';
import { space, useTheme } from '../ui/theme';

/** Camera permission is requested only after the user chose to scan. */
export default function QrScanScreen({ navigation }: RootProps<'QrScan'>) {
  const { c } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const handled = useRef(false);

  const onScan = (r: BarcodeScanningResult) => {
    if (handled.current) return;
    const parsed = parsePairingQr(r.data, Date.now());
    if (!parsed.ok) {
      // Keep scanning, but tell the user why this code was ignored.
      setError(QR_ERROR_MESSAGES[parsed.error]);
      return;
    }
    handled.current = true;
    navigation.navigate('ConnectServer', { scanned: r.data });
  };

  if (!permission) return <Screen><Loading /></Screen>;

  if (!permission.granted) {
    return (
      <Screen>
        <Header title="Scan pairing QR" onBack={() => navigation.goBack()} />
        <T color="textMuted">Qivra needs the camera only to read the pairing QR code shown by your server. Nothing is recorded or stored.</T>
        {permission.canAskAgain ? (
          <Button title="Allow camera" icon="camera-outline" onPress={() => void requestPermission()} style={{ marginTop: space.lg }} />
        ) : (
          <Banner tone="warning" title="Camera permission denied" body="Enable it in Android settings, or enter the server URL and Access ID manually." action={<Button kind="outline" title="Open settings" onPress={() => void Linking.openSettings()} />} />
        )}
        <Button kind="text" title="Enter manually instead" onPress={() => navigation.goBack()} />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {cameraError ? (
        <Screen>
          <Header title="Camera unavailable" onBack={() => navigation.goBack()} />
          <Banner tone="danger" title="The camera could not start" body={`${cameraError}\nUse manual entry instead.`} />
        </Screen>
      ) : (
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onScan}
          onMountError={(e) => setCameraError(e.message)}
          accessibilityLabel="Camera viewfinder for the pairing QR code"
        />
      )}
      <View style={{ position: 'absolute', top: 40, left: space.lg, right: space.lg }}>
        <Button kind="tonal" title="Cancel" icon="close" onPress={() => navigation.goBack()} style={{ alignSelf: 'flex-start' }} />
      </View>
      <View style={{ position: 'absolute', bottom: 40, left: space.lg, right: space.lg, backgroundColor: c.bg, borderRadius: 12, padding: space.md }}>
        <T>Point at the QR code printed by “python -m qivra serve”.</T>
        {error ? <T v="small" color="danger" style={{ marginTop: 4 }}>{error}</T> : null}
      </View>
    </View>
  );
}
