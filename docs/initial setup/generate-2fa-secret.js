// generate-2fa-secret.js
const speakeasy = require('speakeasy');

const secret = speakeasy.generateSecret({
  name: 'DiDe (supervisor1)',
  length: 20, // Increases base32 length
});

console.log('BASE32 manual key:', secret.base32);
console.log('otpauth URL (QR):', secret.otpauth_url);
