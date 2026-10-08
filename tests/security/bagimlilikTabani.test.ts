/**
 * Dependency security baseline (AJAN-4, finding F-10; docs/test-temel/ajan5-guvenlik.md).
 *
 * PURPOSE: catch, deterministically and WITHOUT network access, any return of CRITICAL/HIGH vulnerabilities in production dependencies.
 * The test reads the lock files in the repo (package-lock.json, quant-engine/requirements.txt); it does not run
 * `npm audit`/`pip-audit` (they need the network and change over time). Threshold versions come from the "first patched version"
 * in `npm audit --omit=dev --json` (GitHub Advisory DB) and PyPI/pip-audit output (2026-10-07).
 *
 * OUT OF SCOPE (deliberately): medium/low vulnerabilities. Critical/high only.
 *
 * No new dependency was added for semver; there is a small comparator (MAJOR.MINOR.PATCH[-prerelease] only).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Surum = { major: number; minor: number; patch: number; onSurum: boolean };

function ayristir(metin: string): Surum {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+.*)?$/.exec(metin.trim());
    if (!m) throw new Error(`Could not parse version: "${metin}"`);
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), onSurum: Boolean(m[4]) };
}

/** Negative if a < b, 0 if equal, positive if a > b. A prerelease (1.2.3-rc.1) sorts below the same numbered release. */
function karsilastir(a: string, b: string): number {
    const x = ayristir(a);
    const y = ayristir(b);
    return (
        x.major - y.major ||
        x.minor - y.minor ||
        x.patch - y.patch ||
        Number(y.onSurum) - Number(x.onSurum)
    );
}

describe('version comparator (test helper)', () => {
    it('orders versions correctly', () => {
        expect(karsilastir('1.2.3', '1.2.4')).toBeLessThan(0);
        expect(karsilastir('1.10.0', '1.9.9')).toBeGreaterThan(0);
        expect(karsilastir('2.0.0', '2.0.0')).toBe(0);
        expect(karsilastir('2.0.0-rc.1', '2.0.0')).toBeLessThan(0);
        expect(karsilastir('7.18.2', '7.14.2')).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------------------------
// npm (production dependencies)
// ---------------------------------------------------------------------------------------------

type NpmTaban = {
    /** npm package name */
    paket: string;
    /** lowest version that closes all critical/high advisories (first patched) */
    asgari: string;
    /** first major where the vulnerable range starts; lower majors are not affected by this advisory */
    etkilenenIlkMajor: number;
    /** why it is listed: advisory IDs / note */
    not: string;
};

const NPM_TABAN: readonly NpmTaban[] = [
    { paket: 'proxy-addr', asgari: '2.0.8', etkilenenIlkMajor: 1, not: 'CRITICAL GHSA-jqcg-44mw-7w3h (express dependency)' },
    { paket: 'axios', asgari: '1.20.0', etkilenenIlkMajor: 1, not: 'HIGH GHSA-3pq3-5fj3-cg6v, GHSA-mghh-pgcx-3jjj, GHSA-x97p-jq2g-jp4f, GHSA-m8m8-qj5v-23w3 ...' },
    { paket: 'react-router', asgari: '7.18.2', etkilenenIlkMajor: 7, not: 'HIGH GHSA-8x6r-g9mw-2r78, GHSA-chx6-hx7r-mcp5, GHSA-qwww-vcr4-c8h2' },
    { paket: 'react-router-dom', asgari: '7.18.2', etkilenenIlkMajor: 7, not: 'HIGH (via react-router); 7.18.2 requires react-router@7.18.2' },
    { paket: 'brace-expansion', asgari: '5.0.11', etkilenenIlkMajor: 3, not: 'HIGH GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895, GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7 (1.x/2.x not affected)' },
    { paket: 'fast-uri', asgari: '3.1.7', etkilenenIlkMajor: 3, not: 'HIGH GHSA-qw65-cvwx-89v3 and earlier ones' },
    { paket: 'form-data', asgari: '4.0.6', etkilenenIlkMajor: 4, not: 'HIGH GHSA-hmw2-7cc7-3qxx' },
    { paket: 'hono', asgari: '4.12.25', etkilenenIlkMajor: 4, not: 'HIGH GHSA-88fw-hqm2-52qc' },
    { paket: 'ip-address', asgari: '10.3.1', etkilenenIlkMajor: 10, not: 'HIGH GHSA-mwp4-54f8-5fhr (via express-rate-limit)' },
    { paket: 'protobufjs', asgari: '7.6.1', etkilenenIlkMajor: 7, not: 'HIGH GHSA-wcpc-wj8m-hjx6' },
    { paket: 'ws', asgari: '8.21.0', etkilenenIlkMajor: 8, not: 'HIGH GHSA-96hv-2xvq-fx4p' },
    // prisma family: prisma@7.8.0..7.10.0 PINS EXACT VERSIONS of deepmerge-ts@7.1.5 and mysql2@3.15.3;
    // the prisma@6.19.3 that npm audit suggests is an invalid downgrade/major change. So `package.json` `overrides`
    // force the patched versions; the @prisma/config and prisma highs close with them because these two are their only "via".
    { paket: 'deepmerge-ts', asgari: '8.0.0', etkilenenIlkMajor: 0, not: 'HIGH GHSA-ggr8-5vv4-36mx (source of the @prisma/config and prisma highs)' },
    { paket: 'mysql2', asgari: '3.22.0', etkilenenIlkMajor: 0, not: 'HIGH GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3 (source of the prisma high)' },
];

/**
 * KALAN (remaining): critical/highs that cannot be fixed, with their JUSTIFICATION. The goal is an empty list. Every package
 * added here is skipped by its row in this test; an entry without a justification fails the test.
 */
const KALAN: ReadonlyArray<{ paket: string; gerekce: string }> = [];

type KilitPaketi = { version?: string; dev?: boolean };
const kilit = JSON.parse(readFileSync(resolve(process.cwd(), 'package-lock.json'), 'utf8')) as {
    packages: Record<string, KilitPaketi>;
};

/** `node_modules/a/node_modules/b` -> b ; scoped `node_modules/@x/y` -> @x/y */
function paketAdi(yol: string): string | null {
    const i = yol.lastIndexOf('node_modules/');
    return i === -1 ? null : yol.slice(i + 'node_modules/'.length);
}

function kilitSurumleri(paket: string): Array<{ yol: string; surum: string }> {
    const sonuc: Array<{ yol: string; surum: string }> = [];
    for (const [yol, bilgi] of Object.entries(kilit.packages)) {
        if (paketAdi(yol) === paket && bilgi.version) sonuc.push({ yol, surum: bilgi.version });
    }
    return sonuc;
}

describe('npm: critical/high must not drop below the minimum patched version (package-lock.json)', () => {
    const kalanPaketler = new Set(KALAN.map((k) => k.paket));

    for (const { paket, asgari, etkilenenIlkMajor, not } of NPM_TABAN) {
        if (kalanPaketler.has(paket)) continue;
        it(`${paket} >= ${asgari}  [${not}]`, () => {
            const etkilenen = kilitSurumleri(paket).filter((k) => ayristir(k.surum).major >= etkilenenIlkMajor);
            const acikli = etkilenen.filter((k) => karsilastir(k.surum, asgari) < 0);
            expect(acikli, `${paket}: vulnerable version(s) in the lock file`).toEqual([]);
        });
    }

    it('every entry in the KALAN list carries a justification', () => {
        for (const kayit of KALAN) {
            expect(kayit.gerekce.trim().length, `${kayit.paket} needs a written justification`).toBeGreaterThan(20);
        }
    });

    it('overrides force the patched versions for the prisma family (the npm audit prisma@6.19.3 suggestion is invalid)', () => {
        const paketJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
            overrides?: Record<string, string>;
        };
        for (const ad of ['deepmerge-ts', 'mysql2']) {
            if (kalanPaketler.has(ad)) continue;
            const tanim = paketJson.overrides?.[ad];
            expect(tanim, `package.json overrides.${ad} must be defined`).toBeTruthy();
            const taban = NPM_TABAN.find((t) => t.paket === ad)!.asgari;
            expect(karsilastir(String(tanim).replace(/^[^\d]*/, ''), taban)).toBeGreaterThanOrEqual(0);
        }
    });
});

// ---------------------------------------------------------------------------------------------
// pip (quant-engine/requirements.txt)
// ---------------------------------------------------------------------------------------------

/**
 * starlette CVEs (pip-audit/PyPI): CVE-2024-47874 (0.40.0), CVE-2025-54121 (0.47.2), CVE-2026-48710 (1.0.1),
 * CVE-2026-48818 / CVE-2026-48817 (1.1.0), CVE-2026-54282 (1.3.0), CVE-2026-54283 (1.3.1).
 * Lowest starlette that closes all of them: 1.3.1.
 *
 * fastapi==0.110.0 caps starlette at `>=0.36.3,<0.37`. fastapi removed the starlette upper bound in 0.133.0
 * (0.132.1: `starlette<1.0.0,>=0.40.0`; 0.133.0: `starlette>=0.40.0`) -> the lowest fastapi that allows
 * starlette 1.3.1 is 0.133.0 (verified via PyPI requires_dist). 0.133.0 requires `pydantic>=2.7.0`.
 */
const STARLETTE_ASGARI = '1.3.1';
const FASTAPI_ASGARI = '0.133.0';
const PYDANTIC_ASGARI = '2.7.0';

function requirementSatiri(ad: string): string | undefined {
    const metin = readFileSync(resolve(process.cwd(), 'quant-engine/requirements.txt'), 'utf8');
    return metin
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => /^([A-Za-z0-9_.-]+)/.exec(s)?.[1].toLowerCase() === ad);
}

function sabitSurum(satir: string | undefined): string | undefined {
    return satir ? /==\s*([0-9][^\s;#]*)/.exec(satir)?.[1] : undefined;
}

describe('pip: quant-engine/requirements.txt version baseline that closes the starlette CVEs', () => {
    it(`fastapi pin >= ${FASTAPI_ASGARI} (lowest version that allows starlette >= ${STARLETTE_ASGARI})`, () => {
        const surum = sabitSurum(requirementSatiri('fastapi'));
        expect(surum, 'must be pinned as fastapi==X.Y.Z').toBeDefined();
        expect(karsilastir(surum!, FASTAPI_ASGARI)).toBeGreaterThanOrEqual(0);
    });

    it(`pydantic pin >= ${PYDANTIC_ASGARI} (required by fastapi >= ${FASTAPI_ASGARI})`, () => {
        const surum = sabitSurum(requirementSatiri('pydantic'));
        expect(surum, 'must be pinned as pydantic==X.Y.Z').toBeDefined();
        expect(karsilastir(surum!, PYDANTIC_ASGARI)).toBeGreaterThanOrEqual(0);
    });

    it(`starlette is not pinned below ${STARLETTE_ASGARI} (if pinned, >= ${STARLETTE_ASGARI})`, () => {
        const satir = requirementSatiri('starlette');
        if (satir === undefined) return; // no direct pin: the newest starlette allowed by fastapi gets installed
        const surum = sabitSurum(satir);
        expect(surum, `the starlette line must be pinned with "==": "${satir}"`).toBeDefined();
        expect(karsilastir(surum!, STARLETTE_ASGARI)).toBeGreaterThanOrEqual(0);
        expect(satir).not.toMatch(/<\s*1\.3\.1|<=\s*1\.3\.0/);
    });
});
