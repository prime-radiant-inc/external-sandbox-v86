import forge from 'node-forge';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
/** Ephemeral CA: private material remains in this host process only. */
export function createCertificateAuthority() {
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    const ca = forge.pki.createCertificate();
    ca.publicKey = keys.publicKey;
    ca.serialNumber = '01' + randomBytes(15).toString('hex');
    ca.validity.notBefore = new Date(Date.now() - 60_000);
    ca.validity.notAfter = new Date(Date.now() + 30 * 86_400_000);
    ca.setSubject([{ name: 'commonName', value: 'v86 ephemeral managed proxy CA' }]);
    ca.setIssuer(ca.subject.attributes);
    ca.setExtensions([
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ]);
    ca.sign(keys.privateKey, forge.md.sha256.create());
    const cache = new Map<string, {
        certificate: string;
        privateKey: string;
    }>();
    return {
        certificate: forge.pki.certificateToPem(ca),
        issue(hostname: string) {
            const cached = cache.get(hostname);
            if (cached)
                return cached;
            if (cache.size >= 64)
                throw new Error('Certificate limit reached');
            const leafKeys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
            const cert = forge.pki.createCertificate();
            cert.publicKey = leafKeys.publicKey;
            cert.serialNumber = '01' + randomBytes(15).toString('hex');
            cert.validity.notBefore = ca.validity.notBefore;
            cert.validity.notAfter = ca.validity.notAfter;
            cert.setSubject([{ name: 'commonName', value: hostname }]);
            cert.setIssuer(ca.subject.attributes);
            cert.setExtensions([
                { name: 'basicConstraints', cA: false },
                { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
                { name: 'extKeyUsage', serverAuth: true },
                { name: 'subjectAltName', altNames: [isIP(hostname)
                    ? { type: 7, ip: hostname } : { type: 2, value: hostname }] },
            ]);
            cert.sign(keys.privateKey, forge.md.sha256.create());
            const result = {
                certificate: forge.pki.certificateToPem(cert),
                privateKey: forge.pki.privateKeyToPem(leafKeys.privateKey),
            };
            cache.set(hostname, result);
            return result;
        },
    };
}
