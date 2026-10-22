/**
 * Expo config plugin: Qivra's Android native configuration.
 *
 *  - ShareActivity (ACTION_SEND / ACTION_SEND_MULTIPLE) for links, text,
 *    transcripts (SRT/VTT/TXT), user-chosen audio/video and images (OCR'd on device).
 *  - network_security_config.xml: system CAs only (user-installed CAs are not
 *    trusted). Cleartext stays permitted at the platform level because Android
 *    cannot scope it to private IP ranges; the app's HTTP layer
 *    (src/core/net.ts) refuses http:// to anything but loopback/LAN/VPN hosts.
 *  - Backups disabled (allowBackup=false + data-extraction rules excluding everything).
 *  - Build properties: NDK version available on this machine, ABIs.
 *
 *  - QivraShareTaskService (not exported): headless JS share processing.
 *
 * Native code added: plugins/android/ShareActivity.kt and QivraShareTaskService.kt
 * (documented in docs/ARCHITECTURE.md).
 */
const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod, withGradleProperties, AndroidConfig } = require('expo/config-plugins');

const SHARE_MIME = ['text/plain', 'text/*', 'text/vtt', 'application/x-subrip', 'audio/*', 'video/*', 'image/*'];

function shareActivity(pkg) {
  const filter = (action) => ({
    action: [{ $: { 'android:name': action } }],
    category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
    data: SHARE_MIME.map((m) => ({ $: { 'android:mimeType': m } })),
  });
  return {
    $: {
      'android:name': `${pkg}.ShareActivity`,
      'android:exported': 'true',
      'android:label': '@string/app_name',
      'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
      'android:noHistory': 'true',
      'android:excludeFromRecents': 'true',
      'android:configChanges': 'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode',
      'android:taskAffinity': '',
    },
    'intent-filter': [filter('android.intent.action.SEND'), filter('android.intent.action.SEND_MULTIPLE')],
  };
}

const NSC = `<?xml version="1.0" encoding="utf-8"?>
<!-- Qivra: see plugins/withQivraAndroid.js and docs/SECURITY_AND_PRIVACY.md -->
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

const EXTRACTION = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="root" /><exclude domain="file" /><exclude domain="database" /><exclude domain="sharedpref" /><exclude domain="external" />
  </cloud-backup>
  <device-transfer>
    <exclude domain="root" /><exclude domain="file" /><exclude domain="database" /><exclude domain="sharedpref" /><exclude domain="external" />
  </device-transfer>
</data-extraction-rules>
`;

module.exports = function withQivraAndroid(config, opts = {}) {
  // Machine-specific values come from the environment so app.json stays portable.
  const ndkVersion = opts.ndkVersion ?? process.env.QIVRA_NDK_VERSION;
  const architectures = opts.architectures ?? process.env.QIVRA_ANDROID_ABIS;
  config = withAndroidManifest(config, (cfg) => {
    const pkg = cfg.android?.package ?? AndroidConfig.Package.getPackage(cfg);
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:allowBackup'] = 'false';
    app.$['android:fullBackupContent'] = 'false';
    app.$['android:dataExtractionRules'] = '@xml/qivra_data_extraction_rules';
    app.$['android:networkSecurityConfig'] = '@xml/qivra_network_security_config';
    // biome-ignore lint/performance/noDelete: the attribute must be absent so the NSC file governs cleartext
    delete app.$['android:usesCleartextTraffic'];
    app.activity = (app.activity ?? []).filter((a) => !String(a.$['android:name']).endsWith('ShareActivity'));
    app.activity.push(shareActivity(pkg));
    app.service = (app.service ?? []).filter((sv) => !String(sv.$['android:name']).endsWith('QivraShareTaskService'));
    app.service.push({ $: { 'android:name': `${pkg}.QivraShareTaskService`, 'android:exported': 'false', 'android:foregroundServiceType': 'dataSync' } });
    return cfg;
  });

  config = withDangerousMod(config, ['android', async (cfg) => {
    const pkg = cfg.android.package;
    const root = cfg.modRequest.platformProjectRoot;
    const javaDir = path.join(root, 'app/src/main/java', ...pkg.split('.'));
    fs.mkdirSync(javaDir, { recursive: true });
    for (const file of ['ShareActivity.kt', 'QivraShareTaskService.kt']) {
      const src = fs.readFileSync(path.join(cfg.modRequest.projectRoot, 'plugins/android', file), 'utf8');
      fs.writeFileSync(path.join(javaDir, file), src.replace(/__PACKAGE__/g, pkg));
    }
    const xmlDir = path.join(root, 'app/src/main/res/xml');
    fs.mkdirSync(xmlDir, { recursive: true });
    fs.writeFileSync(path.join(xmlDir, 'qivra_network_security_config.xml'), NSC);
    fs.writeFileSync(path.join(xmlDir, 'qivra_data_extraction_rules.xml'), EXTRACTION);
    return cfg;
  }]);

  config = withGradleProperties(config, (cfg) => {
    const set = (key, value) => {
      cfg.modResults = cfg.modResults.filter((p) => !(p.type === 'property' && p.key === key));
      cfg.modResults.push({ type: 'property', key, value });
    };
    if (ndkVersion) set('ndkVersion', ndkVersion);
    if (architectures) set('reactNativeArchitectures', architectures);
    return cfg;
  });
  return config;
};
