const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { findPackedRef } = require('../update-build-info');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const expectedRelease = `r${manifest.version}`;

describe('release metadata', () => {
    test('finds a branch commit in packed Git references', () => {
        const packedRefs = [
            '# pack-refs with: peeled fully-peeled sorted',
            'a30d8d900000000000000000000000000000000 refs/heads/r1.9'
        ].join('\n');

        expect(findPackedRef(packedRefs, 'refs/heads/r1.9'))
            .toBe('a30d8d900000000000000000000000000000000');
    });

    test('keeps the manifest and README version aligned', () => {
        const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
        const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

        expect(readme).toContain(`**Current version: ${manifest.version}**`);
        expect(readme).toContain(`## What's new in ${manifest.version}`);
        expect(packageMetadata.name).toBe('ops-toolshed-extension');
        expect(packageMetadata.version).toBe(`${manifest.version}.0`);
    });

    test('lists the manifest version first in the release history', () => {
        const toolshed = fs.readFileSync(path.join(root, 'toolshed.html'), 'utf8');
        const dom = new JSDOM(toolshed);

        try {
            const releases = Array.from(dom.window.document.querySelectorAll('#release-notes .release h2'))
                .map(heading => heading.textContent.trim());

            expect(releases[0]).toBe(expectedRelease);
            expect(new Set(releases).size).toBe(releases.length);
        } finally {
            dom.window.close();
        }
    });

    test('keeps the current release focused on Campaign Approval Tracking, Campaign History, and current fixes', () => {
        const toolshed = fs.readFileSync(path.join(root, 'toolshed.html'), 'utf8');
        const dom = new JSDOM(toolshed);

        try {
            const currentRelease = dom.window.document.querySelector('#release-notes .release');
            const items = Array.from(currentRelease.querySelectorAll('li'));

            expect(items).toHaveLength(14);
            expect(items[0].textContent).toContain('Campaign Approval Tracking');
            expect(items[0].querySelector('.release-badge').dataset.releaseType).toBe('new');
            expect(items[1].textContent).toContain('Campaign History');
            expect(items[1].querySelector('.release-badge').dataset.releaseType).toBe('new');
            expect(items[2].textContent).toContain('Diagnostics Mode');
            expect(items[2].querySelector('.release-badge').dataset.releaseType).toBe('new');
            expect(items[3].textContent).toContain('four campaigns per page');
            expect(items[3].querySelector('.release-badge').dataset.releaseType).toBe('improved');
            expect(items[4].textContent).toContain('Campaign Approval Tracking');
            expect(items[4].querySelector('.release-badge').dataset.releaseType).toBe('improved');
            expect(items[5].textContent).toContain('Moe Chat');
            expect(items[5].querySelector('.release-badge').dataset.releaseType).toBe('improved');
            expect(items[6].textContent).toContain('Features Off');
            expect(items[6].querySelector('.release-badge').dataset.releaseType).toBe('improved');
            expect(items[7].textContent).toContain('Not Submitted');
            expect(items[7].querySelector('.release-badge').dataset.releaseType).toBe('fixed');
            expect(items[8].textContent).toContain('already-approved campaign');
            expect(items[8].querySelector('.release-badge').dataset.releaseType).toBe('fixed');
            expect(items[9].textContent).toContain('clear idle state');
            expect(items[9].querySelector('.release-badge').dataset.releaseType).toBe('fixed');
            expect(items[10].textContent).toContain('Redistribute action');
            expect(items[10].querySelector('.release-badge').dataset.releaseType).toBe('fixed');
            expect(items[12].textContent).toContain('permanent Moe chat bubble');
            expect(items[12].querySelector('.release-badge').dataset.releaseType).toBe('fixed');
            expect(items[13].textContent).toContain('retired Loading Fact Review');
            expect(items[13].querySelector('.release-badge').dataset.releaseType).toBe('fixed');
        } finally {
            dom.window.close();
        }
    });

    test('labels and orders every release item as New, Improved, then Fixed', () => {
        const toolshed = fs.readFileSync(path.join(root, 'toolshed.html'), 'utf8');
        const dom = new JSDOM(toolshed);
        const priority = { new: 0, improved: 1, fixed: 2 };

        try {
            const releases = Array.from(dom.window.document.querySelectorAll('#release-notes .release'));
            expect(releases.length).toBeGreaterThan(0);

            releases.forEach(release => {
                const badges = Array.from(release.querySelectorAll('li .release-badge'));
                expect(badges).toHaveLength(release.querySelectorAll('li').length);

                const types = badges.map(badge => badge.dataset.releaseType);
                expect(types.every(type => Object.hasOwn(priority, type))).toBe(true);
                expect(types.map(type => priority[type]))
                    .toEqual([...types].map(type => priority[type]).sort((a, b) => a - b));
            });
        } finally {
            dom.window.close();
        }
    });

    test('uses a connected timeline without card containers for release items', () => {
        const css = fs.readFileSync(path.join(root, 'toolshed.css'), 'utf8');
        const itemRule = css.match(/#release-notes \.release li\s*{([^}]*)}/s)?.[1] || '';

        expect(css).toMatch(/\.release::before\s*{/);
        expect(css).toMatch(/#release-notes \.release li::before\s*{/);
        expect(css).toMatch(/#release-notes \.release li::after\s*{/);
        expect(css).toMatch(/\.release-badge\s*{[^}]*width:\s*68px;/s);
        expect(css).toMatch(/#release-notes \.release li::before\s*{[^}]*top:\s*13px;/s);
        expect(css).toMatch(/#release-notes \.release li::after\s*{[^}]*top:\s*13px;/s);
        expect(itemRule).not.toMatch(/\bborder\s*:/);
        expect(itemRule).not.toMatch(/\bbackground\s*:/);
    });
});
