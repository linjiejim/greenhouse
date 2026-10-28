// App Store Connect and Play accept only numeric versions, while app.json follows the product
// version (release-please extra-files), candidates included: 4.0.0-rc.2 ships as 4.0.0. The
// version is skipped by the fingerprint (fingerprint.config.js), so this keeps OTA compatibility.
module.exports = ({ config }) => ({ ...config, version: String(config.version).split('-')[0] });
