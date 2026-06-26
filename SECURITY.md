# Security Policy

The security of SovEcom — and of the merchants and customer data running on it — is a first-order priority. This document explains how to report vulnerabilities and what to expect in response.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately to:

- **Email:** `security@sovecom.io`
- **PGP:** encrypt your report with our public key (see below).

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept if available).
- Affected version(s) / commit, and environment details.
- Any suggested remediation.

You may also use [GitHub's private vulnerability reporting](https://github.com/asifwanders/SovEcom/security/advisories/new) if enabled.

## Our Commitment

- **Initial response within 48 hours** of a confirmed report.
- We work with you to understand and validate the issue.
- **90-day disclosure window** from confirmed receipt — we aim to ship a fix and coordinate disclosure within that window.
- Paid **Business** and **Enterprise** support customers receive pre-disclosure **7 days** before public release.
- We will credit reporters who wish to be named once a fix is released.

## Scope

In scope: the SovEcom core (API, admin, setup, reference storefront), official first-party modules and themes, and official Docker images.

Out of scope: third-party modules/themes not maintained by us, vulnerabilities in dependencies already disclosed upstream (report those upstream), and issues requiring physical access or a compromised host.

## Bug Bounty

There is **no paid bug bounty in year 1.** We may introduce one (e.g. via huntr.dev) in year 2+. Reports are nonetheless very welcome and credited.

## PGP Key

Security reports may be encrypted with the SovEcom security PGP key.

- **Identity:** `SovEcom Security <security@sovecom.io>`
- **Fingerprint:** `E09B 72DD 8DB7 6821 3CBD  D157 D35C 2669 7BAB D5E1`
- **Type:** Ed25519 (signing/cert) + Curve25519 (encryption) · expires 2028-06-07

To verify the fingerprint after importing:

```
gpg --import security-pubkey.asc
gpg --fingerprint security@sovecom.io
```

```
-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEaickFhYJKwYBBAHaRw8BAQdAWXn1lN4dj8ybRDJ389EslS68WepWTNJ7ATzt
SAEkOVa0RVNvdkVjb20gU2VjdXJpdHkgKFNvdkVjb20gc2VjdXJpdHkgZGlzY2xv
c3VyZXMpIDxzZWN1cml0eUBzb3ZlY29tLmlvPoi1BBMWCgBdFiEE4Jty3Y23aCE8
vdFX01wmaXur1eEFAmonJBYbFIAAAAAABAAObWFudTIsMi41KzEuMTIsMCwzAhsD
BQkDwmcABQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJENNcJml7q9XhcUQA
/3XzTdh6IQNoYtnIGCg3CGt+eaJLMqBNhnHHWRMZq794AQDGSCEJ4IPbsTa4Tdul
t34Znf5NI5ZLMPqfRMzcq5FyALg4BGonJBYSCisGAQQBl1UBBQEBB0D/p0uFzFZ8
iErQadCt0PhncfyQHX2dDqrFYVS6PCo3LgMBCAeImgQYFgoAQhYhBOCbct2Nt2gh
PL3RV9NcJml7q9XhBQJqJyQWGxSAAAAAAAQADm1hbnUyLDIuNSsxLjEyLDAsMwIb
DAUJA8JnAAAKCRDTXCZpe6vV4Z9kAQCucvK9Rd4Q8yQEV+Ecf+AlKbD3vDQ5iIi7
GvykU6+OSwEAmCJrmR7Pct9C7JOBm2oOaUddtobORTiAddfakWZXAwQ=
=5ppV
-----END PGP PUBLIC KEY BLOCK-----
```

## Supported Versions

SovEcom is pre-release. Once `v1.0.0` ships, this table will list which versions receive security updates.

| Version | Supported |
|---|---|
| pre-1.0 (development) | ⚠️ No guarantees — do not run in production |
