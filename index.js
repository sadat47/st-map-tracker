/**
 * Map Tracker — SillyTavern Extension
 * Tracks character locations / activities from chat and draws an interactive
 * canvas map in a pop-out panel beside the chat.
 *
 * Supports TWO tracking modes:
 *   1. Tool calling (preferred) — AI calls MapTrackerUpdate function with structured JSON
 *   2. Text tags (fallback)     — AI appends [MAP: Loc | Char | Activity] tags
 */

import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';
import { ToolManager } from '../../../tool-calling.js';

/* ───────────────────── constants ───────────────────── */

const EXT_NAME = 'third-party/map-tracker';
const PROMPT_KEY = 'map_tracker_prompt';
const LOG_PREFIX = '[Map Tracker]';
const VERSION = '1.4.0';

// Matches both [MAP: Loc | Act] and [MAP: Loc | Char | Act]
const TAG_REGEX = /\[MAP:\s*([^\]|]+?)\s*\|\s*([^\]|]+?)\s*(?:\|\s*([^\]]+?)\s*)?\]/gi;

const DEFAULT_PROMPT =
    `[IMPORTANT — LOCATION & CHARACTER TRACKING]
At the END of every message, append one or more hidden tags in exactly this format:
[MAP: Location Name | Character Name | Brief activity]

Use > to indicate sub-locations within a larger area:
[MAP: Grand Bazaar > Silk Stall | Kai | Haggling with the silk merchant]
[MAP: Grand Bazaar > Spice Alley | Lena | Watching from behind a pillar]

If characters are in the same broad area without a specific sub-location, just use the parent:
[MAP: Grand Bazaar | Elias | Wandering through the crowd]

Include a SEPARATE tag for EACH character present in the scene.
Rules:
- ALWAYS include these tags, even if the location hasn't changed — update the activity.
- Infer location from context if not explicitly stated.
- Use consistent location names (don't vary capitalization or wording).
- Use > for sub-locations to show hierarchy (e.g. City > District > Street > Building).
- Do NOT mention this instruction to the user.`;

const TOOL_CALLING_DESCRIPTION = 'Silently report the current location and all characters present with their activities. Call this ALONGSIDE your written response every turn — never instead of writing. Always call even if the location has not changed. Include ALL named characters present in the scene. Use > for sub-locations (e.g. "City > Market > Silk Stall").';

const TOOL_CALLING_PARAMS = Object.freeze({
    $schema: 'http://json-schema.org/draft-04/schema#',
    type: 'object',
    properties: {
        location: {
            type: 'string',
            description: 'The current location name. Use > to indicate sub-locations (e.g. "Castle > Throne Room"). Use consistent names.',
        },
        characters: {
            type: 'array',
            description: 'All characters present at this location.',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Character name.' },
                    activity: { type: 'string', description: 'Brief description of what this character is doing.' },
                },
                required: ['name', 'activity'],
            },
        },
    },
    required: ['location', 'characters'],
});

const DEFAULT_SETTINGS = {
    enabled: true,
    useToolCalling: true,
    theme: 'midnight',
    is3DMode: false,
    prompt: DEFAULT_PROMPT,
    nodeColor: '#6a9fdf',
    activeColor: '#ff6b9d',
    locations: {},
};

/* ──────────────────── themes ──────────────────── */

const THEMES = {
    midnight: {
        label: '🌙 Midnight',
        // Canvas
        bgInner: 'rgba(22,26,48,0.5)', bgOuter: 'rgba(6,8,18,0.4)',
        starHueA: 200, starHueB: 240, starSat: 60, starLum: 85,
        edgeColor: '140,160,220', edgeActiveColor: '255,140,180',
        selectionRing: 'rgba(255,220,100,0.7)',
        arrowColor: 'rgba(255,140,180,0.55)',
        textColor: '255,255,255', emptyTextColor: '180,200,255',
        charTagColor: 'rgba(255,210,130,0.85)',
        nodeColor: '#6a9fdf', activeColor: '#ff6b9d',
        // CSS vars
        popBg: 'linear-gradient(135deg,rgba(12,14,28,0.92),rgba(20,24,48,0.90),rgba(16,18,36,0.94))',
        popBorder: 'rgba(120,140,200,0.15)', popGlow: 'rgba(80,100,180,0.06)',
        headerBorder: 'rgba(120,140,200,0.08)',
        panelBg: 'rgba(0,0,0,0.15)', panelBorder: 'rgba(120,140,200,0.1)',
        accentText: 'rgba(210,220,255,0.9)', mutedText: 'rgba(180,190,220,0.55)',
        charNameColor: 'rgba(255,210,130,0.85)',
        legendBg: 'rgba(0,0,0,0.12)',
    },
    crimson: {
        label: '🌹 Crimson Romance',
        bgInner: 'rgba(42,12,18,0.6)', bgOuter: 'rgba(14,4,8,0.5)',
        starHueA: 340, starHueB: 360, starSat: 50, starLum: 82,
        edgeColor: '180,100,120', edgeActiveColor: '255,80,120',
        selectionRing: 'rgba(255,150,180,0.7)',
        arrowColor: 'rgba(255,100,140,0.55)',
        textColor: '255,240,245', emptyTextColor: '220,160,180',
        charTagColor: 'rgba(255,180,200,0.85)',
        nodeColor: '#c44569', activeColor: '#ff4475',
        popBg: 'linear-gradient(135deg,rgba(28,8,14,0.94),rgba(42,12,22,0.92),rgba(22,6,12,0.95))',
        popBorder: 'rgba(200,80,120,0.18)', popGlow: 'rgba(180,40,80,0.08)',
        headerBorder: 'rgba(200,80,120,0.1)',
        panelBg: 'rgba(30,0,10,0.2)', panelBorder: 'rgba(200,80,120,0.12)',
        accentText: 'rgba(255,200,220,0.9)', mutedText: 'rgba(200,140,160,0.55)',
        charNameColor: 'rgba(255,180,200,0.85)',
        legendBg: 'rgba(20,0,5,0.15)',
    },
    neonlust: {
        label: '💋 Neon Lust',
        bgInner: 'rgba(18,6,28,0.6)', bgOuter: 'rgba(6,2,12,0.5)',
        starHueA: 280, starHueB: 320, starSat: 70, starLum: 80,
        edgeColor: '200,80,200', edgeActiveColor: '255,40,180',
        selectionRing: 'rgba(255,80,200,0.8)',
        arrowColor: 'rgba(255,60,180,0.6)',
        textColor: '255,230,255', emptyTextColor: '200,140,220',
        charTagColor: 'rgba(255,140,220,0.9)',
        nodeColor: '#a855f7', activeColor: '#ff2d95',
        popBg: 'linear-gradient(135deg,rgba(20,4,30,0.94),rgba(30,8,40,0.92),rgba(16,2,24,0.95))',
        popBorder: 'rgba(255,60,180,0.2)', popGlow: 'rgba(200,40,160,0.1)',
        headerBorder: 'rgba(255,60,180,0.12)',
        panelBg: 'rgba(20,0,30,0.2)', panelBorder: 'rgba(255,60,180,0.12)',
        accentText: 'rgba(255,180,240,0.9)', mutedText: 'rgba(200,130,220,0.55)',
        charNameColor: 'rgba(255,140,220,0.9)',
        legendBg: 'rgba(15,0,20,0.15)',
    },
    sakura: {
        label: '🌸 Sakura Dreams',
        bgInner: 'rgba(38,18,30,0.45)', bgOuter: 'rgba(14,8,14,0.35)',
        starHueA: 310, starHueB: 340, starSat: 45, starLum: 88,
        edgeColor: '200,160,180', edgeActiveColor: '255,140,170',
        selectionRing: 'rgba(255,200,220,0.7)',
        arrowColor: 'rgba(255,160,190,0.5)',
        textColor: '255,245,250', emptyTextColor: '220,180,200',
        charTagColor: 'rgba(255,200,210,0.85)',
        nodeColor: '#e88aab', activeColor: '#ff6b8a',
        popBg: 'linear-gradient(135deg,rgba(24,10,20,0.92),rgba(34,14,28,0.90),rgba(20,8,16,0.94))',
        popBorder: 'rgba(230,140,180,0.18)', popGlow: 'rgba(200,100,140,0.06)',
        headerBorder: 'rgba(230,140,180,0.1)',
        panelBg: 'rgba(20,5,12,0.15)', panelBorder: 'rgba(230,140,180,0.1)',
        accentText: 'rgba(255,220,235,0.9)', mutedText: 'rgba(200,160,180,0.55)',
        charNameColor: 'rgba(255,200,210,0.85)',
        legendBg: 'rgba(15,3,8,0.12)',
    },
    cyberpunk: {
        label: '⚡ Cyberpunk',
        bgInner: 'rgba(6,16,24,0.6)', bgOuter: 'rgba(2,4,10,0.5)',
        starHueA: 170, starHueB: 190, starSat: 80, starLum: 78,
        edgeColor: '0,220,220', edgeActiveColor: '255,220,40',
        selectionRing: 'rgba(0,255,255,0.7)',
        arrowColor: 'rgba(255,220,40,0.6)',
        textColor: '220,255,255', emptyTextColor: '80,200,200',
        charTagColor: 'rgba(255,240,60,0.9)',
        nodeColor: '#00d4ff', activeColor: '#ff3864',
        popBg: 'linear-gradient(135deg,rgba(4,10,20,0.95),rgba(8,18,30,0.93),rgba(2,6,14,0.96))',
        popBorder: 'rgba(0,200,255,0.2)', popGlow: 'rgba(0,150,200,0.1)',
        headerBorder: 'rgba(0,200,255,0.12)',
        panelBg: 'rgba(0,10,15,0.25)', panelBorder: 'rgba(0,200,255,0.12)',
        accentText: 'rgba(100,240,255,0.9)', mutedText: 'rgba(60,180,200,0.55)',
        charNameColor: 'rgba(255,240,60,0.9)',
        legendBg: 'rgba(0,5,10,0.2)',
    },
    fantasy: {
        label: '🧝 Enchanted Forest',
        bgInner: 'rgba(8,24,12,0.5)', bgOuter: 'rgba(2,10,4,0.4)',
        starHueA: 80, starHueB: 140, starSat: 50, starLum: 82,
        edgeColor: '100,180,120', edgeActiveColor: '200,255,100',
        selectionRing: 'rgba(200,255,140,0.7)',
        arrowColor: 'rgba(200,255,100,0.5)',
        textColor: '230,255,230', emptyTextColor: '140,200,140',
        charTagColor: 'rgba(255,230,120,0.85)',
        nodeColor: '#4ade80', activeColor: '#facc15',
        popBg: 'linear-gradient(135deg,rgba(6,18,10,0.94),rgba(10,26,14,0.92),rgba(4,14,8,0.95))',
        popBorder: 'rgba(80,180,100,0.18)', popGlow: 'rgba(60,140,80,0.08)',
        headerBorder: 'rgba(80,180,100,0.1)',
        panelBg: 'rgba(0,12,4,0.18)', panelBorder: 'rgba(80,180,100,0.1)',
        accentText: 'rgba(180,240,200,0.9)', mutedText: 'rgba(120,180,140,0.55)',
        charNameColor: 'rgba(255,230,120,0.85)',
        legendBg: 'rgba(0,8,2,0.15)',
    },
    abyss: {
        label: '🕳️ Abyss',
        bgInner: 'rgba(8,8,10,0.6)', bgOuter: 'rgba(2,2,4,0.5)',
        starHueA: 0, starHueB: 360, starSat: 10, starLum: 70,
        edgeColor: '100,100,110', edgeActiveColor: '160,160,170',
        selectionRing: 'rgba(200,200,210,0.5)',
        arrowColor: 'rgba(180,180,190,0.4)',
        textColor: '200,200,210', emptyTextColor: '100,100,120',
        charTagColor: 'rgba(180,180,200,0.7)',
        nodeColor: '#64748b', activeColor: '#94a3b8',
        popBg: 'linear-gradient(135deg,rgba(6,6,8,0.96),rgba(10,10,14,0.94),rgba(4,4,6,0.97))',
        popBorder: 'rgba(80,80,100,0.12)', popGlow: 'rgba(40,40,60,0.06)',
        headerBorder: 'rgba(80,80,100,0.08)',
        panelBg: 'rgba(0,0,0,0.2)', panelBorder: 'rgba(80,80,100,0.08)',
        accentText: 'rgba(180,180,200,0.8)', mutedText: 'rgba(120,120,140,0.5)',
        charNameColor: 'rgba(180,180,200,0.7)',
        legendBg: 'rgba(0,0,0,0.15)',
    },
};

function getTheme() {
    const s = settings();
    return THEMES[s.theme] || THEMES.midnight;
}

function applyThemeCSSVars() {
    const el = document.getElementById('map-tracker-popout');
    if (!el) return;
    const t = getTheme();
    el.style.setProperty('--mt-pop-bg', t.popBg);
    el.style.setProperty('--mt-pop-border', t.popBorder);
    el.style.setProperty('--mt-pop-glow', t.popGlow);
    el.style.setProperty('--mt-header-border', t.headerBorder);
    el.style.setProperty('--mt-panel-bg', t.panelBg);
    el.style.setProperty('--mt-panel-border', t.panelBorder);
    el.style.setProperty('--mt-accent-text', t.accentText);
    el.style.setProperty('--mt-muted-text', t.mutedText);
    el.style.setProperty('--mt-char-name', t.charNameColor);
    el.style.setProperty('--mt-legend-bg', t.legendBg);
    el.style.setProperty('--mt-node-color', t.nodeColor);
    el.style.setProperty('--mt-active-color', t.activeColor);
}

/* ──────────────────── state ──────────────────── */

let popoutOpen = false;
let dragState = null;
let mapCanvas = null;
let mapCtx = null;
let currentChatId = null;
let animFrame = null;

// Starfield
let starField = null;
let starTime = 0;

// Camera (zoom + pan)
let camera = { x: 0, y: 0, zoom: 1.0 };
let isPanning = false;
let panStart = { x: 0, y: 0, camX: 0, camY: 0 };
let panMoved = false;

// Node interaction
let selectedNode = null;
let nodePositions = {};

// Hierarchical navigation
let viewPath = [];

// Layer transition animation
let layerTransition = { active: false, startTime: 0, duration: 400, direction: 'in' };

// 3D mode
let is3DMode = false;

/* ──────────────────── helpers ──────────────────── */

function settings() { return extension_settings[EXT_NAME]; }

function chatLocations() {
    const s = settings();
    if (!currentChatId) return [];
    if (!s.locations[currentChatId]) s.locations[currentChatId] = [];
    return s.locations[currentChatId];
}

function saveLocs() { saveSettingsDebounced(); }

/**
 * Normalize a location name to prevent duplicates from casing/spacing.
 * Returns the canonical (first-seen) version.
 */
function canonicalLocation(rawName) {
    const key = rawName.toLowerCase().replace(/\s+/g, ' ').trim();
    const locs = chatLocations();
    for (const entry of locs) {
        const entryKey = entry.location.toLowerCase().replace(/\s+/g, ' ').trim();
        if (entryKey === key) return entry.location;
    }
    return rawName.trim();
}

/* ──────────────────── hierarchy helpers ──────────────────── */

/**
 * Split a location string into path segments.
 * "City > Market > Silk Stall" → ["City", "Market", "Silk Stall"]
 */
function parsePath(locationStr) {
    return locationStr.split('>').map(s => s.trim()).filter(Boolean);
}

/**
 * Check if a path array starts with a given prefix array (case-insensitive).
 */
function pathStartsWith(path, prefix) {
    if (path.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
        if (path[i].toLowerCase().replace(/\s+/g, ' ').trim() !== prefix[i].toLowerCase().replace(/\s+/g, ' ').trim()) return false;
    }
    return true;
}

/**
 * Get unique node names visible at the current viewPath depth.
 */
function getNodesAtLevel(locs, vPath) {
    const names = new Set();
    for (const entry of locs) {
        const path = parsePath(entry.location);
        if (!pathStartsWith(path, vPath)) continue;
        if (path.length > vPath.length) {
            names.add(path[vPath.length]);
        }
    }
    return [...names];
}

/**
 * Check if a node at the current viewPath level has children (deeper sub-locations).
 */
function nodeHasChildren(locs, vPath, nodeName) {
    const fullPath = [...vPath, nodeName];
    for (const entry of locs) {
        const path = parsePath(entry.location);
        if (path.length > fullPath.length && pathStartsWith(path, fullPath)) return true;
    }
    return false;
}

/**
 * Get all entries that belong to a node (exact or descendants).
 */
function getEntriesForNode(locs, vPath, nodeName) {
    const fullPath = [...vPath, nodeName];
    return locs.filter(entry => {
        const path = parsePath(entry.location);
        return path.length >= fullPath.length && pathStartsWith(path, fullPath);
    });
}

/**
 * Get the child count (unique sub-location names) under a node.
 */
function getChildCount(locs, vPath, nodeName) {
    const fullPath = [...vPath, nodeName];
    const children = new Set();
    for (const entry of locs) {
        const path = parsePath(entry.location);
        if (path.length > fullPath.length && pathStartsWith(path, fullPath)) {
            children.add(path[fullPath.length]);
        }
    }
    return children.size;
}

function hexToRGB(hex) {
    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
    };
}

/* ──────────────────── prompt injection ──────────────────── */

function isToolCallingActive() {
    const s = settings();
    return s.enabled && s.useToolCalling && ToolManager.isToolCallingSupported();
}

function buildKnownLocationsBlock() {
    const locs = chatLocations();
    if (locs.length === 0) return '';
    const unique = [...new Set(locs.map(l => l.location))].sort();
    if (unique.length === 0) return '';
    return `\n\n[KNOWN LOCATIONS — USE EXACT NAMES]\nThe following locations have already been established. You MUST reuse these EXACT names (including capitalization and > hierarchy) when characters are at these places. Only create a new location name if the characters move somewhere genuinely new that is not on this list.\n${unique.map(l => `• ${l}`).join('\n')}`;
}

function injectPrompt() {
    const s = settings();
    if (!s.enabled) {
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
        return;
    }
    const knownBlock = buildKnownLocationsBlock();
    // When tool calling is active, we still inject a lighter prompt as a hint
    if (isToolCallingActive()) {
        const toolHint = `[LOCATION TRACKING — IMPORTANT]
You have access to the MapTrackerUpdate tool. You MUST do BOTH of the following every turn:
1. Write your full narrative response as normal — NEVER skip or shorten your message because of this tool.
2. Call MapTrackerUpdate alongside your response to silently report the current location and all characters present with their activities.

Use > to indicate sub-locations within a larger area (e.g. "Castle > Throne Room", "City > Market > Silk Stall").
If no specific sub-location, just use the parent name.

The tool call is invisible to the user and runs in the background. It must NEVER replace your written response. Always update activities even if the location hasn't changed. Do NOT mention location tracking to the user.${knownBlock}`;
        setExtensionPrompt(PROMPT_KEY, toolHint, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    } else {
        setExtensionPrompt(PROMPT_KEY, s.prompt + knownBlock, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    }
}

/* ──────────────────── tool calling ──────────────────── */

function handleToolCall(args) {
    if (!args || !args.location) return 'Error: missing location';
    if (!currentChatId) return 'Error: no active chat';

    const locName = canonicalLocation(args.location);
    const characters = Array.isArray(args.characters) ? args.characters : [];
    const locs = chatLocations();
    const now = Date.now();

    if (characters.length === 0) {
        // Fallback: just track the location with "Unknown" character
        locs.push({ character: 'Unknown', location: locName, activity: '', messageIndex: -1, timestamp: now });
    } else {
        for (const ch of characters) {
            const charName = (ch.name || 'Unknown').trim();
            const activity = (ch.activity || '').trim();
            locs.push({ character: charName, location: locName, activity, messageIndex: -1, timestamp: now });
            console.log(LOG_PREFIX, `[Tool] Tracked: "${charName}" @ "${locName}" — ${activity}`);
        }
    }

    saveLocs();
    injectPrompt(); // Refresh known-locations list for next turn
    return `Tracked ${characters.length} character(s) at "${locName}".`;
}

function registerMapTool() {
    const s = settings();
    if (!s.enabled || !s.useToolCalling) {
        ToolManager.unregisterFunctionTool('MapTrackerUpdate');
        return;
    }

    ToolManager.registerFunctionTool({
        name: 'MapTrackerUpdate',
        displayName: 'Map Tracker',
        description: TOOL_CALLING_DESCRIPTION,
        parameters: TOOL_CALLING_PARAMS,
        action: async (args) => handleToolCall(args),
        formatMessage: (args) => `📍 Tracking ${args?.characters?.length || 0} character(s) at "${args?.location || '?'}"`,
        shouldRegister: () => {
            const s = settings();
            return s.enabled && s.useToolCalling;
        },
        stealth: true,
    });
    console.log(LOG_PREFIX, 'Registered MapTrackerUpdate function tool');
}

/* ──────────────────── tag parsing ──────────────────── */

function parseTags(text) {
    const matches = [];
    let m;
    const re = new RegExp(TAG_REGEX.source, TAG_REGEX.flags);
    while ((m = re.exec(text)) !== null) {
        if (m[3]) {
            // 3-part: [MAP: Location | Character | Activity]
            matches.push({ location: m[1].trim(), character: m[2].trim(), activity: m[3].trim() });
        } else {
            // 2-part: [MAP: Location | Activity] — character comes from msg.name
            matches.push({ location: m[1].trim(), character: null, activity: m[2].trim() });
        }
    }
    const cleaned = text.replace(TAG_REGEX, '').trim();
    return { matches, cleaned };
}

function stripTagsFromElement(messageElement) {
    if (!messageElement) return;
    const mesText = messageElement.querySelector('.mes_text');
    if (!mesText) return;
    const html = mesText.innerHTML;
    const stripped = html.replace(/\[MAP:\s*[^\]]*\]/gi, '').trim();
    if (stripped !== html) mesText.innerHTML = stripped;
}

/* ──────────────────── process messages ──────────────────── */

function processMessage(messageIndex) {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat || messageIndex < 0 || messageIndex >= chat.length) return false;
    const msg = chat[messageIndex];
    if (!msg || msg.is_user) return false;
    const raw = msg.mes || '';
    const { matches, cleaned } = parseTags(raw);
    if (matches.length > 0) {
        msg.mes = cleaned;
        const defaultChar = msg.name || 'Unknown';
        for (const m of matches) {
            const locName = canonicalLocation(m.location);
            const charName = m.character || defaultChar;
            const locs = chatLocations();

            // Dedup: same messageIndex + location + character = skip
            const already = locs.some(l =>
                l.messageIndex === messageIndex &&
                l.location === locName &&
                l.character === charName,
            );
            if (!already) {
                locs.push({
                    character: charName,
                    location: locName,
                    activity: m.activity,
                    messageIndex,
                    timestamp: Date.now(),
                });
                console.log(LOG_PREFIX, `Tracked: "${charName}" @ "${locName}" — ${m.activity}`);
            }
        }
        saveLocs();
        return true;
    }
    return false;
}

function scanAllMessages() {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat || chat.length === 0) return;
    let found = 0;
    for (let i = 0; i < chat.length; i++) { if (processMessage(i)) found++; }
    if (found > 0) {
        console.log(LOG_PREFIX, `Scan found tags in ${found} messages`);
        injectPrompt(); // Refresh known-locations list
    }
}

/* ──────────────────── delete helpers ──────────────────── */

function deleteNode(locationName) {
    const s = settings();
    s.locations[currentChatId] = chatLocations().filter(l => l.location !== locationName);
    if (selectedNode === locationName) { selectedNode = null; hideDetailPanel(); }
    saveLocs();
    console.log(LOG_PREFIX, `Deleted node: "${locationName}"`);
}

function clearAllNodes() {
    const s = settings();
    if (currentChatId) {
        s.locations[currentChatId] = [];
        selectedNode = null;
        hideDetailPanel();
        saveLocs();
        console.log(LOG_PREFIX, 'Cleared all nodes');
    }
}

/* ──────────────────── event handlers ──────────────────── */

function onMessageReceived(idx) { processMessage(idx); }

function onGenerationEnded(idx) {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat || chat.length === 0) return;
    const i = (typeof idx === 'number' && idx >= 0 && idx < chat.length) ? idx : chat.length - 1;
    processMessage(i);
    stripTagsFromElement(document.querySelector(`.mes[mesid="${i}"]`));
}

function onMessageRendered(idx) {
    processMessage(idx);
    stripTagsFromElement(document.querySelector(`.mes[mesid="${idx}"]`));
}

function onChatChanged() {
    const ctx = getContext();
    currentChatId = ctx.chatId || null;
    viewPath = [];
    selectedNode = null;
    hideDetailPanel();
    injectPrompt();
    scanAllMessages();
    requestAnimationFrame(() => document.querySelectorAll('.mes').forEach(el => stripTagsFromElement(el)));
}

/* ──────────────────── popout ──────────────────── */

function buildPopoutHTML() {
    return `
    <div id="map-tracker-popout">
        <div id="map-tracker-header">
            <span class="title"><span class="icon">🗺️</span>Map Tracker</span>
            <div id="map-tracker-zoom-controls">
                <button id="map-tracker-3d-toggle" title="Toggle 3D Mode">◆ 3D</button>
                <button id="map-tracker-zoom-in" title="Zoom In">+</button>
                <span id="map-tracker-zoom-level">100%</span>
                <button id="map-tracker-zoom-out" title="Zoom Out">−</button>
                <button id="map-tracker-zoom-reset" title="Reset View">⟲</button>
            </div>
            <button id="map-tracker-close" title="Close">✕</button>
        </div>
        <div id="map-tracker-breadcrumbs">
            <button id="map-tracker-back" title="Go back">←</button>
            <div id="map-tracker-path"><span class="crumb root" data-level="-1">🌍 Root</span></div>
        </div>
        <div id="map-tracker-body">
            <div id="map-tracker-canvas-wrap">
                <canvas id="map-tracker-canvas"></canvas>
            </div>
            <div id="map-tracker-detail" class="hidden">
                <div id="map-tracker-detail-header">
                    <span id="map-tracker-detail-title"></span>
                    <button id="map-tracker-detail-close" title="Close panel">✕</button>
                </div>
                <div id="map-tracker-detail-body"></div>
                <div id="map-tracker-detail-footer">
                    <button id="map-tracker-delete-node">🗑 Delete Location</button>
                </div>
            </div>
        </div>
        <div id="map-tracker-legend">
            <span><span class="dot visited"></span>Visited</span>
            <span><span class="dot active"></span>Current</span>
            <span id="map-tracker-loc-count">0 locations</span>
            <button id="map-tracker-clear-all" title="Clear all locations">🗑 Clear All</button>
            <span id="map-tracker-version">v${VERSION}</span>
        </div>
    </div>`;
}

function openPopout() {
    let el = document.getElementById('map-tracker-popout');
    if (!el) {
        document.body.insertAdjacentHTML('beforeend', buildPopoutHTML());
        el = document.getElementById('map-tracker-popout');
        setupDrag(el);
        setupZoomControls();
        setupCanvasInteractions();
        document.getElementById('map-tracker-close').addEventListener('click', closePopout);
        document.getElementById('map-tracker-clear-all').addEventListener('click', clearAllNodes);
        document.getElementById('map-tracker-delete-node').addEventListener('click', () => {
            if (selectedNode) deleteNode(selectedNode);
        });
        document.getElementById('map-tracker-detail-close').addEventListener('click', () => {
            selectedNode = null;
            hideDetailPanel();
        });
        document.getElementById('map-tracker-back').addEventListener('click', () => {
            if (viewPath.length > 0) {
                viewPath.pop();
                camera = { x: 0, y: 0, zoom: 1.0 };
                starField = null;
                nebulaField = null;
                ambientParticles = null;
                selectedNode = null;
                hideDetailPanel();
                updateBreadcrumbs();
                startLayerTransition('out');
            }
        });
        document.getElementById('map-tracker-3d-toggle').addEventListener('click', () => {
            is3DMode = !is3DMode;
            const s = settings();
            s.is3DMode = is3DMode;
            saveSettingsDebounced();
            document.getElementById('map-tracker-3d-toggle').classList.toggle('active', is3DMode);
            starField = null;
            nebulaField = null;
            ambientParticles = null;
        });
    }
    el.classList.add('open');
    popoutOpen = true;
    starField = null;
    nebulaField = null;
    ambientParticles = null;
    camera = { x: 0, y: 0, zoom: 1.0 };
    viewPath = [];
    selectedNode = null;
    is3DMode = settings().is3DMode || false;
    const btn3d = document.getElementById('map-tracker-3d-toggle');
    if (btn3d) btn3d.classList.toggle('active', is3DMode);
    hideDetailPanel();
    updateBreadcrumbs();
    applyThemeCSSVars();
    initCanvas();
    startAnimation();
}

function closePopout() {
    const el = document.getElementById('map-tracker-popout');
    if (el) el.classList.remove('open');
    popoutOpen = false;
    stopAnimation();
}

function togglePopout() { popoutOpen ? closePopout() : openPopout(); }

/* ──── detail panel ──── */

function showDetailPanel(locName) {
    const panel = document.getElementById('map-tracker-detail');
    const title = document.getElementById('map-tracker-detail-title');
    const body = document.getElementById('map-tracker-detail-body');
    if (!panel || !title || !body) return;

    const allLocs = chatLocations();
    const entries = getEntriesForNode(allLocs, viewPath, locName);
    title.textContent = locName;

    // Build character → latest activity map + visit history
    const charMap = {};   // char → { activity, timestamp, count }
    for (const entry of entries) {
        if (!charMap[entry.character]) {
            charMap[entry.character] = { activity: entry.activity, timestamp: entry.timestamp, count: 0 };
        }
        charMap[entry.character].count++;
        if (entry.timestamp >= charMap[entry.character].timestamp) {
            charMap[entry.character].activity = entry.activity;
            charMap[entry.character].timestamp = entry.timestamp;
        }
    }

    let html = '<div class="detail-section"><div class="detail-label">Characters</div>';
    for (const [charName, info] of Object.entries(charMap)) {
        html += `<div class="detail-char">
            <span class="detail-char-name">📍 ${escapeHtml(charName)}</span>
            <span class="detail-char-visits">×${info.count}</span>
        </div>
        <div class="detail-activity">${escapeHtml(info.activity)}</div>`;
    }
    html += '</div>';

    html += `<div class="detail-section"><div class="detail-label">Visit History</div>`;
    const recent = [...entries].reverse().slice(0, 8);
    for (const entry of recent) {
        const timeStr = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        html += `<div class="detail-history-row">
            <span class="detail-history-char">${escapeHtml(entry.character)}</span>
            <span class="detail-history-act">${escapeHtml(entry.activity)}</span>
            <span class="detail-history-time">${timeStr}</span>
        </div>`;
    }
    if (entries.length > 8) html += `<div class="detail-history-more">+ ${entries.length - 8} more entries</div>`;
    html += '</div>';

    body.innerHTML = html;
    panel.classList.remove('hidden');
}

function hideDetailPanel() {
    const panel = document.getElementById('map-tracker-detail');
    if (panel) panel.classList.add('hidden');
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

/* ──── zoom controls ──── */

function setupZoomControls() {
    document.getElementById('map-tracker-zoom-in').addEventListener('click', () => applyZoom(1.2));
    document.getElementById('map-tracker-zoom-out').addEventListener('click', () => applyZoom(1 / 1.2));
    document.getElementById('map-tracker-zoom-reset').addEventListener('click', () => {
        camera = { x: 0, y: 0, zoom: 1.0 };
        updateZoomLabel();
    });
}

function applyZoom(factor, pivotX, pivotY) {
    const oldZoom = camera.zoom;
    camera.zoom = Math.max(0.3, Math.min(5.0, camera.zoom * factor));
    const realFactor = camera.zoom / oldZoom;
    if (pivotX !== undefined && pivotY !== undefined) {
        camera.x = pivotX - (pivotX - camera.x) * realFactor;
        camera.y = pivotY - (pivotY - camera.y) * realFactor;
    }
    updateZoomLabel();
}

function updateZoomLabel() {
    const el = document.getElementById('map-tracker-zoom-level');
    if (el) el.textContent = Math.round(camera.zoom * 100) + '%';
}

/* ──── canvas interactions ──── */

function setupCanvasInteractions() {
    const wrap = document.getElementById('map-tracker-canvas-wrap');
    if (!wrap) return;

    wrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        applyZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, mx, my);
    }, { passive: false });

    wrap.addEventListener('mousedown', (e) => {
        if (e.button === 0 || e.button === 1) {
            isPanning = true;
            panMoved = false;
            panStart = { x: e.clientX, y: e.clientY, camX: camera.x, camY: camera.y };
            e.preventDefault();
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        const dx = e.clientX - panStart.x;
        const dy = e.clientY - panStart.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved = true;
        camera.x = panStart.camX + dx;
        camera.y = panStart.camY + dy;
    });

    window.addEventListener('mouseup', (e) => {
        if (isPanning && !panMoved && e.button === 0) handleCanvasClick(e);
        isPanning = false;
    });
}

function screenToWorld(sx, sy) {
    const dpr = window.devicePixelRatio || 1;
    const W = mapCanvas.width / dpr;
    const H = mapCanvas.height / dpr;
    return {
        x: (sx - W / 2 - camera.x) / camera.zoom + W / 2,
        y: (sy - H / 2 - camera.y) / camera.zoom + H / 2,
    };
}

function handleCanvasClick(e) {
    if (!mapCanvas) return;
    if (panMoved) return; // Ignore click after pan
    const rect = mapCanvas.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

    let hit = null;
    for (const [name, pos] of Object.entries(nodePositions)) {
        const dx = world.x - pos.x;
        const dy = world.y - pos.y;
        if (Math.sqrt(dx * dx + dy * dy) <= pos.r + 5) { hit = name; break; }
    }

    if (hit) {
        const locs = chatLocations();
        if (nodeHasChildren(locs, viewPath, hit)) {
            // Drill into sub-location
            viewPath.push(hit);
            camera = { x: 0, y: 0, zoom: 1.0 };
            starField = null;
            nebulaField = null;
            ambientParticles = null;
            selectedNode = null;
            hideDetailPanel();
            updateBreadcrumbs();
            startLayerTransition('in');
        } else {
            // Leaf node — toggle detail panel
            if (selectedNode === hit) {
                selectedNode = null;
                hideDetailPanel();
            } else {
                selectedNode = hit;
                showDetailPanel(hit);
            }
        }
    } else {
        selectedNode = null;
        hideDetailPanel();
    }
}

/* ── breadcrumbs ── */

function updateBreadcrumbs() {
    const pathEl = document.getElementById('map-tracker-path');
    const backBtn = document.getElementById('map-tracker-back');
    if (!pathEl) return;

    let html = '<span class="crumb root" data-level="-1">🌍 Root</span>';
    for (let i = 0; i < viewPath.length; i++) {
        html += `<span class="crumb-sep">›</span><span class="crumb" data-level="${i}">${escapeHtml(viewPath[i])}</span>`;
    }
    pathEl.innerHTML = html;

    // Back button visibility
    if (backBtn) backBtn.style.display = viewPath.length > 0 ? '' : 'none';

    // Click handlers for breadcrumbs
    pathEl.querySelectorAll('.crumb').forEach(el => {
        el.addEventListener('click', () => {
            const level = parseInt(el.dataset.level);
            navigateToLevel(level);
        });
    });
}

function navigateToLevel(level) {
    if (level < 0) {
        viewPath = [];
    } else {
        viewPath = viewPath.slice(0, level + 1);
    }
    camera = { x: 0, y: 0, zoom: 1.0 };
    starField = null;
    nebulaField = null;
    ambientParticles = null;
    selectedNode = null;
    hideDetailPanel();
    updateBreadcrumbs();
    startLayerTransition('out');
}

function startLayerTransition(direction) {
    layerTransition = { active: true, startTime: performance.now(), duration: 400, direction };
}

/* ──── drag popout ──── */

function setupDrag(popout) {
    const header = popout.querySelector('#map-tracker-header');
    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('#map-tracker-zoom-controls') || e.target.id === 'map-tracker-close') return;
        dragState = { startX: e.clientX, startY: e.clientY, origLeft: popout.offsetLeft, origTop: popout.offsetTop };
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragState) return;
        const p = document.getElementById('map-tracker-popout');
        if (p) { p.style.left = (dragState.origLeft + e.clientX - dragState.startX) + 'px'; p.style.top = (dragState.origTop + e.clientY - dragState.startY) + 'px'; p.style.right = 'auto'; }
    });
    document.addEventListener('mouseup', () => { dragState = null; });
}

/* ──────────────────── canvas ──────────────────── */

function initCanvas() {
    mapCanvas = document.getElementById('map-tracker-canvas');
    if (!mapCanvas) return;
    mapCtx = mapCanvas.getContext('2d');
    resizeCanvas();
    new ResizeObserver(resizeCanvas).observe(mapCanvas.parentElement);
}

function resizeCanvas() {
    if (!mapCanvas || !mapCanvas.parentElement) return;
    const rect = mapCanvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    mapCanvas.width = rect.width * dpr;
    mapCanvas.height = rect.height * dpr;
    mapCanvas.style.width = rect.width + 'px';
    mapCanvas.style.height = rect.height + 'px';
    starField = null;
}

/* ──────────────────── animation loop ──────────────────── */

function startAnimation() {
    stopAnimation();
    const tick = (ts) => {
        starTime = ts * 0.001;
        renderFrame();
        if (popoutOpen) animFrame = requestAnimationFrame(tick);
    };
    animFrame = requestAnimationFrame(tick);
}

function stopAnimation() {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
}

/* ═══════════════════════════════════════════════
        F O R C E - D I R E C T E D   L A Y O U T
   ═══════════════════════════════════════════════ */

function computeLayout(uniqueLocs, edges, W, H) {
    const MARGIN = 90;
    const n = uniqueLocs.length;
    if (n === 0) return {};
    if (n === 1) return { [uniqueLocs[0]]: { x: W / 2, y: H / 2 } };

    const positions = {};
    uniqueLocs.forEach((loc, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        const radius = Math.min(W, H) * 0.35;
        positions[loc] = { x: W / 2 + radius * Math.cos(angle), y: H / 2 + radius * Math.sin(angle), vx: 0, vy: 0 };
    });

    const ITERATIONS = 80;
    const REPULSION = 8000;
    const ATTRACTION = 0.008;
    const IDEAL_DIST = Math.max(100, Math.min(W, H) / Math.sqrt(n) * 0.8);
    const DAMPING = 0.85;
    const CENTER_PULL = 0.01;

    for (let iter = 0; iter < ITERATIONS; iter++) {
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const a = positions[uniqueLocs[i]], b = positions[uniqueLocs[j]];
                let dx = a.x - b.x, dy = a.y - b.y;
                let dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const f = REPULSION / (dist * dist);
                const fx = (dx / dist) * f, fy = (dy / dist) * f;
                a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
            }
        }
        for (const [aName, bName] of edges) {
            const a = positions[aName], b = positions[bName];
            if (!a || !b) continue;
            let dx = b.x - a.x, dy = b.y - a.y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const disp = dist - IDEAL_DIST;
            const f = disp * ATTRACTION;
            const fx = (dx / dist) * f, fy = (dy / dist) * f;
            a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
        for (const loc of uniqueLocs) {
            const p = positions[loc];
            p.vx += (W / 2 - p.x) * CENTER_PULL;
            p.vy += (H / 2 - p.y) * CENTER_PULL;
            p.vx *= DAMPING; p.vy *= DAMPING;
            p.x += p.vx; p.y += p.vy;
            p.x = Math.max(MARGIN, Math.min(W - MARGIN, p.x));
            p.y = Math.max(MARGIN, Math.min(H - MARGIN, p.y));
        }
    }

    const result = {};
    for (const loc of uniqueLocs) result[loc] = { x: positions[loc].x, y: positions[loc].y };
    return result;
}

/* ═══════════════════════════════════════════════
              M A P   R E N D E R E R
   ═══════════════════════════════════════════════ */

function generateStars(W, H) {
    const t = getTheme();
    const stars = [];
    const count = Math.floor((W * H) / 700);
    for (let i = 0; i < count; i++) {
        stars.push({
            x: Math.random() * W * 1.4 - W * 0.2,
            y: Math.random() * H * 1.4 - H * 0.2,
            r: Math.random() * 1.6 + 0.15,
            baseAlpha: Math.random() * 0.5 + 0.05,
            phase: Math.random() * Math.PI * 2,
            speed: Math.random() * 1.8 + 0.3,
            hue: t.starHueA + Math.random() * (t.starHueB - t.starHueA),
            sat: t.starSat,
            lum: t.starLum,
        });
    }
    return stars;
}

// ─── Nebula cloud system ───
let nebulaField = null;

function generateNebulae(W, H) {
    const t = getTheme();
    const clouds = [];
    const count = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
        clouds.push({
            x: Math.random() * W,
            y: Math.random() * H,
            radius: 80 + Math.random() * 200,
            hue: t.starHueA + Math.random() * (t.starHueB - t.starHueA),
            sat: Math.max(20, t.starSat - 15 + Math.random() * 30),
            baseAlpha: 0.02 + Math.random() * 0.04,
            driftX: (Math.random() - 0.5) * 0.15,
            driftY: (Math.random() - 0.5) * 0.1,
            phase: Math.random() * Math.PI * 2,
            breatheSpeed: 0.3 + Math.random() * 0.5,
        });
    }
    return clouds;
}

function drawNebulae(W, H) {
    if (!nebulaField) nebulaField = generateNebulae(W, H);
    for (const c of nebulaField) {
        const breathe = 1 + Math.sin(starTime * c.breatheSpeed + c.phase) * 0.15;
        const cx = c.x + Math.sin(starTime * 0.1 + c.phase) * c.driftX * 100;
        const cy = c.y + Math.cos(starTime * 0.08 + c.phase) * c.driftY * 100;
        const r = c.radius * breathe;
        const alpha = c.baseAlpha + Math.sin(starTime * c.breatheSpeed * 0.7 + c.phase) * 0.01;

        const grad = mapCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, `hsla(${c.hue}, ${c.sat}%, ${40}%, ${alpha * 1.5})`);
        grad.addColorStop(0.4, `hsla(${c.hue + 15}, ${c.sat - 10}%, ${30}%, ${alpha})`);
        grad.addColorStop(1, `hsla(${c.hue}, ${c.sat}%, ${20}%, 0)`);
        mapCtx.fillStyle = grad;
        mapCtx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
}

// ─── Shooting stars ───
let shootingStars = [];

function updateShootingStars(W, H) {
    const t = getTheme();
    // Spawn occasionally
    if (Math.random() < 0.008 && shootingStars.length < 3) {
        const angle = Math.PI * 0.15 + Math.random() * Math.PI * 0.3;
        const speed = 3 + Math.random() * 5;
        shootingStars.push({
            x: Math.random() * W * 0.8,
            y: Math.random() * H * 0.3,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 1.0,
            decay: 0.008 + Math.random() * 0.015,
            length: 30 + Math.random() * 50,
            hue: t.starHueA + Math.random() * (t.starHueB - t.starHueA),
        });
    }
    // Update + draw
    shootingStars = shootingStars.filter(s => s.life > 0);
    for (const s of shootingStars) {
        s.x += s.vx;
        s.y += s.vy;
        s.life -= s.decay;
        const tailX = s.x - s.vx * s.length * 0.3;
        const tailY = s.y - s.vy * s.length * 0.3;
        const grad = mapCtx.createLinearGradient(tailX, tailY, s.x, s.y);
        grad.addColorStop(0, `hsla(${s.hue}, 60%, 90%, 0)`);
        grad.addColorStop(0.7, `hsla(${s.hue}, 70%, 92%, ${s.life * 0.3})`);
        grad.addColorStop(1, `hsla(${s.hue}, 80%, 97%, ${s.life * 0.7})`);
        mapCtx.beginPath();
        mapCtx.moveTo(tailX, tailY);
        mapCtx.lineTo(s.x, s.y);
        mapCtx.strokeStyle = grad;
        mapCtx.lineWidth = 1.5;
        mapCtx.stroke();
        // Head glow
        mapCtx.beginPath();
        mapCtx.arc(s.x, s.y, 2, 0, Math.PI * 2);
        mapCtx.fillStyle = `hsla(${s.hue}, 80%, 95%, ${s.life * 0.6})`;
        mapCtx.fill();
    }
}

function drawStarfield(W, H) {
    if (!starField) starField = generateStars(W, H);

    // Nebula clouds (behind stars)
    drawNebulae(W, H);

    // Stars
    for (const s of starField) {
        const twinkle = Math.sin(starTime * s.speed + s.phase);
        const alpha = s.baseAlpha + twinkle * s.baseAlpha * 0.7;
        if (alpha <= 0.01) continue;
        const px = s.x + camera.x * 0.15, py = s.y + camera.y * 0.15;

        mapCtx.beginPath();
        mapCtx.arc(px, py, s.r, 0, Math.PI * 2);
        mapCtx.fillStyle = `hsla(${s.hue}, ${s.sat}%, ${s.lum}%, ${Math.max(0, alpha)})`;
        mapCtx.fill();

        // Soft halo on medium stars
        if (s.r > 0.9 && alpha > 0.2) {
            mapCtx.beginPath();
            mapCtx.arc(px, py, s.r * 3, 0, Math.PI * 2);
            mapCtx.fillStyle = `hsla(${s.hue}, ${s.sat - 10}%, ${s.lum - 5}%, ${alpha * 0.1})`;
            mapCtx.fill();
        }

        // Cross spikes on brightest stars
        if (s.r > 1.3 && alpha > 0.35) {
            const spikeLen = s.r * 5 * alpha;
            mapCtx.save();
            mapCtx.globalAlpha = alpha * 0.2;
            mapCtx.strokeStyle = `hsla(${s.hue}, ${s.sat}%, ${s.lum + 10}%, 1)`;
            mapCtx.lineWidth = 0.5;
            mapCtx.beginPath();
            mapCtx.moveTo(px - spikeLen, py); mapCtx.lineTo(px + spikeLen, py);
            mapCtx.moveTo(px, py - spikeLen); mapCtx.lineTo(px, py + spikeLen);
            mapCtx.stroke();
            mapCtx.restore();
        }
    }

    // Shooting stars
    updateShootingStars(W, H);
}

// ─── Ambient floating particles ───
let ambientParticles = null;

function generateAmbientParticles(W, H) {
    const t = getTheme();
    const particles = [];
    const count = 20 + Math.floor(Math.random() * 15);
    for (let i = 0; i < count; i++) {
        particles.push({
            x: Math.random() * W,
            y: Math.random() * H,
            vx: (Math.random() - 0.5) * 0.3,
            vy: (Math.random() - 0.5) * 0.2 - 0.1,
            r: 0.5 + Math.random() * 1.5,
            alpha: 0.03 + Math.random() * 0.08,
            hue: t.starHueA + Math.random() * (t.starHueB - t.starHueA),
            sat: t.starSat,
            phase: Math.random() * Math.PI * 2,
        });
    }
    return particles;
}

function drawAmbientParticles(W, H) {
    if (!ambientParticles) ambientParticles = generateAmbientParticles(W, H);
    for (const p of ambientParticles) {
        p.x += p.vx + Math.sin(starTime * 0.5 + p.phase) * 0.1;
        p.y += p.vy + Math.cos(starTime * 0.3 + p.phase) * 0.05;
        // Wrap around
        if (p.x < -10) p.x = W + 10;
        if (p.x > W + 10) p.x = -10;
        if (p.y < -10) p.y = H + 10;
        if (p.y > H + 10) p.y = -10;

        const flicker = p.alpha + Math.sin(starTime * 2 + p.phase) * p.alpha * 0.4;
        mapCtx.beginPath();
        mapCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        mapCtx.fillStyle = `hsla(${p.hue}, ${p.sat}%, 80%, ${Math.max(0, flicker)})`;
        mapCtx.fill();
    }
}

/* ─── 3D Projection helpers ─── */

const ISO_TILT = 0.55; // Tilt angle (radians) — ~31°
const ISO_PERSPECTIVE = 800; // Perspective depth

function projectIso(x, y, z, W, H) {
    // Center coordinates
    const cx = x - W / 2;
    const cy = y - H / 2;

    // Apply tilt (rotate around X axis)
    const cosT = Math.cos(ISO_TILT);
    const sinT = Math.sin(ISO_TILT);
    const ry = cy * cosT - z * sinT;
    const rz = cy * sinT + z * cosT;

    // Perspective division
    const perspScale = ISO_PERSPECTIVE / (ISO_PERSPECTIVE + rz);
    const px = cx * perspScale + W / 2;
    const py = ry * perspScale + H / 2;

    return { x: px, y: py, scale: perspScale, depth: rz };
}

function draw3DGrid(W, H, t) {
    const gridColor = `rgba(${t.edgeColor}, 0.06)`;
    const gridSpacing = 60;
    const gridExtent = Math.max(W, H) * 0.8;
    const gridZ = 80; // Floor plane z-offset

    mapCtx.save();
    mapCtx.lineWidth = 0.5;
    mapCtx.strokeStyle = gridColor;

    // Draw grid lines in X direction
    for (let gx = -gridExtent; gx <= gridExtent; gx += gridSpacing) {
        const p1 = projectIso(W / 2 + gx, H / 2 - gridExtent, gridZ, W, H);
        const p2 = projectIso(W / 2 + gx, H / 2 + gridExtent, gridZ, W, H);
        // Fade with distance
        const fade = 1 - Math.abs(gx) / gridExtent;
        mapCtx.globalAlpha = fade * 0.5;
        mapCtx.beginPath();
        mapCtx.moveTo(p1.x, p1.y);
        mapCtx.lineTo(p2.x, p2.y);
        mapCtx.stroke();
    }

    // Draw grid lines in Y direction
    for (let gy = -gridExtent; gy <= gridExtent; gy += gridSpacing) {
        const p1 = projectIso(W / 2 - gridExtent, H / 2 + gy, gridZ, W, H);
        const p2 = projectIso(W / 2 + gridExtent, H / 2 + gy, gridZ, W, H);
        const fade = 1 - Math.abs(gy) / gridExtent;
        mapCtx.globalAlpha = fade * 0.5;
        mapCtx.beginPath();
        mapCtx.moveTo(p1.x, p1.y);
        mapCtx.lineTo(p2.x, p2.y);
        mapCtx.stroke();
    }

    mapCtx.globalAlpha = 1;
    mapCtx.restore();
}

function renderFrame() {
    if (!mapCtx || !mapCanvas) return;
    const s = settings();
    const locs = chatLocations();
    const dpr = window.devicePixelRatio || 1;
    const W = mapCanvas.width / dpr;
    const H = mapCanvas.height / dpr;

    mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mapCtx.clearRect(0, 0, W, H);

    // Theme
    const t = getTheme();

    // Background — multi-stop gradient for depth
    const bgGrad = mapCtx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
    bgGrad.addColorStop(0, t.bgInner);
    bgGrad.addColorStop(0.5, t.bgOuter);
    bgGrad.addColorStop(1, t.bgOuter);
    mapCtx.fillStyle = bgGrad;
    mapCtx.fillRect(0, 0, W, H);

    // Secondary subtle glow spot that drifts
    const glowX = W * 0.5 + Math.sin(starTime * 0.15) * W * 0.2;
    const glowY = H * 0.5 + Math.cos(starTime * 0.12) * H * 0.15;
    const bgGlow = mapCtx.createRadialGradient(glowX, glowY, 0, glowX, glowY, Math.max(W, H) * 0.4);
    bgGlow.addColorStop(0, `hsla(${(t.starHueA + t.starHueB) / 2}, ${t.starSat}%, 20%, 0.04)`);
    bgGlow.addColorStop(1, 'transparent');
    mapCtx.fillStyle = bgGlow;
    mapCtx.fillRect(0, 0, W, H);

    drawStarfield(W, H);
    drawAmbientParticles(W, H);
    if (is3DMode) draw3DGrid(W, H, t);

    // Layer transition animation
    let transAlpha = 1;
    let transZoom = 1;
    if (layerTransition.active) {
        const elapsed = performance.now() - layerTransition.startTime;
        const progress = Math.min(elapsed / layerTransition.duration, 1);
        const ease = 1 - Math.pow(1 - progress, 3); // ease-out cubic
        transAlpha = ease;
        if (layerTransition.direction === 'in') {
            transZoom = 0.6 + 0.4 * ease;  // zoom in from 60% to 100%
        } else {
            transZoom = 1.4 - 0.4 * ease;  // zoom out from 140% to 100%
        }
        if (progress >= 1) layerTransition.active = false;
    }

    // Camera
    mapCtx.save();
    mapCtx.globalAlpha = transAlpha;
    mapCtx.translate(W / 2 + camera.x, H / 2 + camera.y);
    mapCtx.scale(camera.zoom * transZoom, camera.zoom * transZoom);
    mapCtx.translate(-W / 2, -H / 2);

    // Legend — count ALL unique full-path locations
    const countEl = document.getElementById('map-tracker-loc-count');
    const allUniqueLocs = [...new Set(locs.map(l => l.location))];
    if (countEl) countEl.textContent = `${allUniqueLocs.length} location${allUniqueLocs.length !== 1 ? 's' : ''}`;

    const vDot = document.querySelector('#map-tracker-legend .dot.visited');
    const aDot = document.querySelector('#map-tracker-legend .dot.active');
    if (vDot) vDot.style.background = s.nodeColor;
    if (aDot) aDot.style.background = s.activeColor;

    // Get nodes at current viewPath level
    const uniqueLocs = getNodesAtLevel(locs, viewPath);

    if (uniqueLocs.length === 0) {
        mapCtx.textAlign = 'center';
        mapCtx.textBaseline = 'middle';
        mapCtx.font = '500 14px "Segoe UI", system-ui, sans-serif';
        mapCtx.fillStyle = `rgba(${t.emptyTextColor}, 0.25)`;
        const msg = viewPath.length > 0 ? `No sub-locations in "${viewPath[viewPath.length - 1]}"` : 'No locations tracked yet';
        mapCtx.fillText(msg, W / 2, H / 2 - 10);
        mapCtx.font = '12px "Segoe UI", system-ui, sans-serif';
        mapCtx.fillStyle = `rgba(${t.emptyTextColor}, 0.15)`;
        mapCtx.fillText(viewPath.length > 0 ? 'Go back or chat to add sub-locations' : 'Chat to populate the map', W / 2, H / 2 + 14);
        mapCtx.restore();
        return;
    }

    // Build edges at current viewPath level
    const movePath = [];
    for (const entry of locs) {
        const path = parsePath(entry.location);
        if (!pathStartsWith(path, viewPath)) continue;
        if (path.length <= viewPath.length) continue;
        const nodeAtLevel = path[viewPath.length];
        if (movePath.length === 0 || movePath[movePath.length - 1] !== nodeAtLevel) {
            movePath.push(nodeAtLevel);
        }
    }
    const edgeSet = new Set();
    const edges = [];
    for (let i = 1; i < movePath.length; i++) {
        const key = [movePath[i - 1], movePath[i]].sort().join('|||');
        if (!edgeSet.has(key)) { edgeSet.add(key); edges.push([movePath[i - 1], movePath[i]]); }
    }

    // Layout
    const layout = computeLayout(uniqueLocs, edges, W, H);

    // Build node data using hierarchy helpers
    const nodeMap = {};
    nodePositions = {};
    for (const loc of uniqueLocs) {
        const pos = layout[loc];
        const entries = getEntriesForNode(locs, viewPath, loc);
        const characters = {};
        let visits = 0;
        for (const entry of entries) {
            visits++;
            if (!characters[entry.character]) {
                characters[entry.character] = { activity: entry.activity, timestamp: entry.timestamp };
            }
            if (entry.timestamp >= characters[entry.character].timestamp) {
                characters[entry.character].activity = entry.activity;
                characters[entry.character].timestamp = entry.timestamp;
            }
        }
        nodeMap[loc] = { x: pos.x, y: pos.y, visits, characters, hasChildren: nodeHasChildren(locs, viewPath, loc), childCount: getChildCount(locs, viewPath, loc) };
    }

    // Determine current location at this level
    const latestEntry = locs[locs.length - 1];
    let currentLoc = null;
    if (latestEntry) {
        const latestPath = parsePath(latestEntry.location);
        if (pathStartsWith(latestPath, viewPath) && latestPath.length > viewPath.length) {
            currentLoc = latestPath[viewPath.length];
        }
    }

    // ─── 3D projection pass ───
    if (is3DMode) {
        for (const [locName, node] of Object.entries(nodeMap)) {
            const z = (node.y - H / 2) * 0.4; // depth from Y position
            const proj = projectIso(node.x, node.y, z, W, H);
            node.x = proj.x;
            node.y = proj.y;
            node._scale = proj.scale;
            node._depth = proj.depth;
            node._z = z;
        }
    }

    // ─── Sort order (back-to-front for 3D) ───
    const drawOrder = Object.entries(nodeMap);
    if (is3DMode) drawOrder.sort((a, b) => b[1]._depth - a[1]._depth);

    // ─── Draw edges ───
    for (let i = 1; i < movePath.length; i++) {
        const from = nodeMap[movePath[i - 1]], to = nodeMap[movePath[i]];
        if (!from || !to || from === to) continue;
        const isLatest = (i === movePath.length - 1);
        const edgeAlpha3D = is3DMode ? 0.7 : 1;
        const alpha = (isLatest ? 0.5 : 0.12) * edgeAlpha3D;
        const midX = (from.x + to.x) / 2, midY = (from.y + to.y) / 2;
        const perpX = -(to.y - from.y) * 0.1, perpY = (to.x - from.x) * 0.1;

        // Edge line
        mapCtx.beginPath();
        mapCtx.moveTo(from.x, from.y);
        mapCtx.quadraticCurveTo(midX + perpX, midY + perpY, to.x, to.y);
        mapCtx.strokeStyle = isLatest ? `rgba(${t.edgeActiveColor}, ${alpha})` : `rgba(${t.edgeColor}, ${alpha})`;
        mapCtx.lineWidth = isLatest ? 2.5 : 1;
        mapCtx.setLineDash(isLatest ? [] : [3, 5]);
        mapCtx.stroke();
        mapCtx.setLineDash([]);

        // Glow on active edge
        if (isLatest) {
            mapCtx.save();
            mapCtx.beginPath();
            mapCtx.moveTo(from.x, from.y);
            mapCtx.quadraticCurveTo(midX + perpX, midY + perpY, to.x, to.y);
            mapCtx.strokeStyle = `rgba(${t.edgeActiveColor}, 0.08)`;
            mapCtx.lineWidth = 8;
            mapCtx.stroke();
            mapCtx.restore();
            drawCurvedArrow(from, to, midX + perpX, midY + perpY, t);
        }

        // Traveling energy particles along edges
        if (isLatest) {
            for (let p = 0; p < 3; p++) {
                const progress = ((starTime * 0.4 + p * 0.33) % 1);
                const invP = 1 - progress;
                const px = from.x * invP * invP + 2 * (midX + perpX) * invP * progress + to.x * progress * progress;
                const py = from.y * invP * invP + 2 * (midY + perpY) * invP * progress + to.y * progress * progress;
                const pAlpha = Math.sin(progress * Math.PI) * 0.6;
                mapCtx.beginPath();
                mapCtx.arc(px, py, 2, 0, Math.PI * 2);
                mapCtx.fillStyle = `rgba(${t.edgeActiveColor}, ${pAlpha})`;
                mapCtx.fill();
                mapCtx.beginPath();
                mapCtx.arc(px, py, 5, 0, Math.PI * 2);
                mapCtx.fillStyle = `rgba(${t.edgeActiveColor}, ${pAlpha * 0.15})`;
                mapCtx.fill();
            }
        }
    }

    // ─── 3D drop shadows (before nodes) ───
    if (is3DMode) {
        for (const [locName, node] of drawOrder) {
            const charCount = Object.keys(node.characters).length;
            const rawR = 28 + Math.min(charCount * 3, 12) + Math.min(node.visits * 0.5, 6);
            const scaledR = rawR * (node._scale || 1);
            const shadowY = node.y + scaledR * 0.8;
            mapCtx.save();
            mapCtx.beginPath();
            mapCtx.ellipse(node.x, shadowY, scaledR * 1.1, scaledR * 0.3, 0, 0, Math.PI * 2);
            mapCtx.fillStyle = 'rgba(0,0,0,0.15)';
            mapCtx.fill();
            mapCtx.restore();
        }
    }

    // ─── Draw nodes ───
    for (const [locName, node] of drawOrder) {
        const isCurrent = locName === currentLoc;
        const isSelected = locName === selectedNode;
        const charCount = Object.keys(node.characters).length;
        const baseR = (28 + Math.min(charCount * 3, 12) + Math.min(node.visits * 0.5, 6)) * (is3DMode ? (node._scale || 1) : 1);
        const color = isCurrent ? s.activeColor : s.nodeColor;
        const rgb = hexToRGB(color);

        nodePositions[locName] = { x: node.x, y: node.y, r: baseR };

        // Selection ring
        if (isSelected) {
            mapCtx.save();
            mapCtx.beginPath();
            if (is3DMode) {
                mapCtx.ellipse(node.x, node.y, baseR + 10, (baseR + 10) * 0.65, 0, 0, Math.PI * 2);
            } else {
                mapCtx.arc(node.x, node.y, baseR + 10, 0, Math.PI * 2);
            }
            mapCtx.lineWidth = 2;
            mapCtx.strokeStyle = t.selectionRing;
            mapCtx.setLineDash([4, 4]);
            mapCtx.lineDashOffset = starTime * 20;
            mapCtx.stroke();
            mapCtx.setLineDash([]);
            mapCtx.restore();
        }

        // Outer ambient glow (all nodes)
        mapCtx.save();
        const ambGlow = mapCtx.createRadialGradient(node.x, node.y, baseR * 0.5, node.x, node.y, baseR + 20);
        ambGlow.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.06)`);
        ambGlow.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.0)`);
        mapCtx.fillStyle = ambGlow;
        mapCtx.beginPath();
        mapCtx.arc(node.x, node.y, baseR + 20, 0, Math.PI * 2);
        mapCtx.fill();
        mapCtx.restore();

        // Pulse glow (current node — bigger, more vibrant)
        if (isCurrent) {
            const pulse = 0.6 + Math.sin(starTime * 2.0) * 0.2;
            mapCtx.save();
            const glow = mapCtx.createRadialGradient(node.x, node.y, baseR * 0.5, node.x, node.y, baseR + 45);
            glow.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${pulse * 0.3})`);
            glow.addColorStop(0.6, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${pulse * 0.08})`);
            glow.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.0)`);
            mapCtx.fillStyle = glow;
            mapCtx.beginPath();
            mapCtx.arc(node.x, node.y, baseR + 45, 0, Math.PI * 2);
            mapCtx.fill();
            mapCtx.restore();
        }

        // Disc with frosted glass effect
        const dg = mapCtx.createRadialGradient(node.x - baseR * 0.25, node.y - baseR * 0.25, 0, node.x, node.y, baseR);
        if (is3DMode) {
            // 3D sphere shading — bright upper-left, dark lower-right
            dg.addColorStop(0, `rgba(${Math.min(255, rgb.r + 90)}, ${Math.min(255, rgb.g + 90)}, ${Math.min(255, rgb.b + 90)}, 0.5)`);
            dg.addColorStop(0.4, `rgba(${Math.min(255, rgb.r + 30)}, ${Math.min(255, rgb.g + 30)}, ${Math.min(255, rgb.b + 30)}, 0.25)`);
            dg.addColorStop(0.8, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`);
            dg.addColorStop(1, `rgba(${Math.max(0, rgb.r - 30)}, ${Math.max(0, rgb.g - 30)}, ${Math.max(0, rgb.b - 30)}, 0.06)`);
        } else {
            dg.addColorStop(0, `rgba(${Math.min(255, rgb.r + 60)}, ${Math.min(255, rgb.g + 60)}, ${Math.min(255, rgb.b + 60)}, 0.4)`);
            dg.addColorStop(0.6, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`);
            dg.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`);
        }
        mapCtx.beginPath();
        if (is3DMode) {
            mapCtx.ellipse(node.x, node.y, baseR, baseR * 0.65, 0, 0, Math.PI * 2);
        } else {
            mapCtx.arc(node.x, node.y, baseR, 0, Math.PI * 2);
        }
        mapCtx.fillStyle = dg;
        mapCtx.fill();

        // Rim highlight
        mapCtx.lineWidth = isCurrent ? 2.5 : 1.2;
        mapCtx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isCurrent ? 0.85 : 0.35})`;
        mapCtx.stroke();

        // Top highlight arc (glass shine)
        mapCtx.save();
        mapCtx.beginPath();
        mapCtx.arc(node.x, node.y, baseR - 2, -Math.PI * 0.7, -Math.PI * 0.3);
        mapCtx.lineWidth = 1;
        mapCtx.strokeStyle = `rgba(255, 255, 255, ${isCurrent ? 0.12 : 0.05})`;
        mapCtx.stroke();
        mapCtx.restore();

        // Inner ring for current
        if (isCurrent) {
            mapCtx.beginPath();
            mapCtx.arc(node.x, node.y, baseR - 5, 0, Math.PI * 2);
            mapCtx.lineWidth = 0.8;
            mapCtx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.25)`;
            mapCtx.stroke();

            // Core light
            const coreGlow = mapCtx.createRadialGradient(node.x, node.y, 0, node.x, node.y, baseR * 0.4);
            coreGlow.addColorStop(0, `rgba(${Math.min(255, rgb.r + 80)}, ${Math.min(255, rgb.g + 80)}, ${Math.min(255, rgb.b + 80)}, 0.15)`);
            coreGlow.addColorStop(1, 'transparent');
            mapCtx.fillStyle = coreGlow;
            mapCtx.beginPath();
            mapCtx.arc(node.x, node.y, baseR * 0.4, 0, Math.PI * 2);
            mapCtx.fill();
        }

        // Orbiting particles (current node)
        if (isCurrent) {
            for (let oi = 0; oi < 4; oi++) {
                const orbitR = baseR + 14;
                const angle = starTime * 1.2 + oi * (Math.PI / 2);
                const ox = node.x + Math.cos(angle) * orbitR;
                const oy = node.y + Math.sin(angle) * orbitR;
                const oAlpha = 0.3 + Math.sin(starTime * 3 + oi) * 0.15;
                mapCtx.beginPath();
                mapCtx.arc(ox, oy, 1.5, 0, Math.PI * 2);
                mapCtx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${oAlpha})`;
                mapCtx.fill();
            }
        }

        // ─── Child indicator (dashed outer ring + count) ───
        if (node.hasChildren) {
            mapCtx.save();
            mapCtx.beginPath();
            mapCtx.arc(node.x, node.y, baseR + 5, 0, Math.PI * 2);
            mapCtx.lineWidth = 1.5;
            mapCtx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`;
            mapCtx.setLineDash([2, 3]);
            mapCtx.lineDashOffset = -starTime * 8;
            mapCtx.stroke();
            mapCtx.setLineDash([]);
            mapCtx.restore();

            // Child count badge
            mapCtx.textAlign = 'center';
            mapCtx.textBaseline = 'middle';
            mapCtx.font = '600 8px "Segoe UI", system-ui, sans-serif';
            mapCtx.fillStyle = `rgba(${t.textColor}, 0.5)`;
            mapCtx.fillText(`▸ ${node.childCount}`, node.x, node.y + baseR + 18);
        }

        // ─── Labels ───
        mapCtx.textAlign = 'center';
        mapCtx.textBaseline = 'middle';
        mapCtx.font = isCurrent ? '600 12px "Segoe UI", system-ui, sans-serif' : '500 11px "Segoe UI", system-ui, sans-serif';
        mapCtx.fillStyle = `rgba(${t.textColor}, ${isCurrent ? 0.95 : 0.8})`;

        // Text shadow for readability
        mapCtx.save();
        mapCtx.shadowColor = 'rgba(0,0,0,0.6)';
        mapCtx.shadowBlur = 4;

        const lines = wrapText(mapCtx, locName, baseR * 3);
        const lineH = 14;
        const textTop = node.y - ((lines.length - 1) * lineH) / 2 - 4;
        for (let li = 0; li < lines.length; li++) {
            mapCtx.fillText(lines[li], node.x, textTop + li * lineH);
        }
        mapCtx.restore();

        // Character count + visit count
        mapCtx.font = '500 9px "Segoe UI", system-ui, sans-serif';
        mapCtx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.6)`;
        const badge = charCount > 1 ? `👤${charCount}  ×${node.visits}` : `×${node.visits}`;
        mapCtx.fillText(badge, node.x, textTop + lines.length * lineH + 2);

        // Character names above current node
        if (isCurrent) {
            const chars = Object.keys(node.characters);
            if (chars.length > 0) {
                mapCtx.save();
                mapCtx.shadowColor = 'rgba(0,0,0,0.5)';
                mapCtx.shadowBlur = 3;
                mapCtx.font = '600 11px "Segoe UI", system-ui, sans-serif';
                mapCtx.fillStyle = t.charTagColor;
                const charDisplay = fitText(mapCtx, chars.join(', '), 200);
                mapCtx.fillText('📍 ' + charDisplay, node.x, node.y - baseR - 16);
                mapCtx.restore();
            }
        }
    }

    mapCtx.restore();
}

/* ──── text helpers ──── */

function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
}

function wrapText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return [text];
    const words = text.split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
        const test = current ? current + ' ' + word : word;
        if (ctx.measureText(test).width <= maxWidth) { current = test; }
        else { if (current) lines.push(current); current = word; }
    }
    if (current) lines.push(current);
    if (lines.length > 2) { lines.length = 2; lines[1] = fitText(ctx, lines[1], maxWidth); }
    return lines.length > 0 ? lines : [fitText(ctx, text, maxWidth)];
}

/* ──── arrow ──── */

function drawCurvedArrow(from, to, cpX, cpY, theme) {
    const t = 0.6;
    const ax = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * cpX + t ** 2 * to.x;
    const ay = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * cpY + t ** 2 * to.y;
    const tx = 2 * (1 - t) * (cpX - from.x) + 2 * t * (to.x - cpX);
    const ty = 2 * (1 - t) * (cpY - from.y) + 2 * t * (to.y - cpY);
    const angle = Math.atan2(ty, tx);
    mapCtx.save();
    mapCtx.fillStyle = theme.arrowColor;
    mapCtx.beginPath();
    mapCtx.moveTo(ax, ay);
    mapCtx.lineTo(ax - 10 * Math.cos(angle - 0.45), ay - 10 * Math.sin(angle - 0.45));
    mapCtx.lineTo(ax - 10 * Math.cos(angle + 0.45), ay - 10 * Math.sin(angle + 0.45));
    mapCtx.closePath();
    mapCtx.fill();
    mapCtx.restore();
}

/* ──────────────────── settings UI ──────────────────── */

async function loadSettingsUI() {
    const html = await renderExtensionTemplateAsync(EXT_NAME, 'settings');
    $('#extensions_settings').append(html);
    const s = settings();

    $('#map_tracker_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = !!$(this).prop('checked'); injectPrompt(); registerMapTool(); saveSettingsDebounced();
    });
    $('#map_tracker_use_tool_calling').prop('checked', s.useToolCalling).on('change', function () {
        s.useToolCalling = !!$(this).prop('checked'); injectPrompt(); registerMapTool(); saveSettingsDebounced();
        updateToolCallingStatus();
    });
    $('#map_tracker_prompt').val(s.prompt).on('input', function () {
        s.prompt = $(this).val(); injectPrompt(); saveSettingsDebounced();
    });
    $('#map_tracker_restore_prompt').on('click', () => {
        s.prompt = DEFAULT_PROMPT; $('#map_tracker_prompt').val(DEFAULT_PROMPT); injectPrompt(); saveSettingsDebounced();
    });
    $('#map_tracker_open_map').on('click', togglePopout);
    $('#map_tracker_clear_history').on('click', clearAllNodes);
    $('#map_tracker_node_color').val(s.nodeColor).on('input', function () {
        s.nodeColor = $(this).val(); saveSettingsDebounced();
    });
    $('#map_tracker_active_color').val(s.activeColor).on('input', function () {
        s.activeColor = $(this).val(); saveSettingsDebounced();
    });

    // Theme selector
    const themeSel = document.getElementById('map_tracker_theme');
    if (themeSel) {
        themeSel.innerHTML = '';
        for (const [key, theme] of Object.entries(THEMES)) {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = theme.label;
            if (key === s.theme) opt.selected = true;
            themeSel.appendChild(opt);
        }
        $(themeSel).on('change', function () {
            const newTheme = $(this).val();
            s.theme = newTheme;
            // Update node/active colors to match theme defaults
            const t = THEMES[newTheme] || THEMES.midnight;
            s.nodeColor = t.nodeColor;
            s.activeColor = t.activeColor;
            $('#map_tracker_node_color').val(s.nodeColor);
            $('#map_tracker_active_color').val(s.activeColor);
            // Regenerate starfield for new colors
            starField = null;
            applyThemeCSSVars();
            saveSettingsDebounced();
        });
    }

    updateToolCallingStatus();
}

function updateToolCallingStatus() {
    const supported = ToolManager.isToolCallingSupported();
    const active = isToolCallingActive();
    const el = document.getElementById('map_tracker_tool_status');
    if (el) {
        if (active) {
            el.textContent = '🟢 Tool calling active';
            el.style.color = 'rgba(100, 220, 140, 0.8)';
        } else if (supported) {
            el.textContent = '🟡 Available but disabled';
            el.style.color = 'rgba(220, 200, 100, 0.8)';
        } else {
            el.textContent = '🔴 Not supported by current API';
            el.style.color = 'rgba(220, 100, 100, 0.6)';
        }
    }
}

/* ──────────────────── wand menu ──────────────────── */

function addMenuButton() {
    const btn = document.createElement('div');
    btn.id = 'map-tracker-wand-btn';
    btn.className = 'list-group-item flex-container flexGap5';
    btn.title = 'Toggle Map Tracker';
    btn.innerHTML = '<span>🗺️</span> Map';
    btn.addEventListener('click', togglePopout);
    const menu = document.getElementById('extensionsMenu');
    if (menu) menu.appendChild(btn);
}

/* ──────────────────── init ──────────────────── */

function initSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    const s = extension_settings[EXT_NAME];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = JSON.parse(JSON.stringify(v));
    }
}

jQuery(async () => {
    initSettings();
    await loadSettingsUI();
    addMenuButton();
    injectPrompt();
    registerMapTool();

    eventSource.on(event_types.MESSAGE_RECEIVED, (idx) => onMessageReceived(idx));
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (idx) => onMessageRendered(idx));
    eventSource.on(event_types.GENERATION_ENDED, (idx) => onGenerationEnded(idx));
    eventSource.on(event_types.CHAT_CHANGED, () => onChatChanged());
    eventSource.on(event_types.MESSAGE_SWIPED, (data) => {
        requestAnimationFrame(() => onMessageRendered(typeof data === 'object' ? data.id : data));
    });

    const ctx = getContext();
    currentChatId = ctx.chatId || null;
    if (currentChatId) scanAllMessages();
    console.log(LOG_PREFIX, 'Extension loaded —', isToolCallingActive() ? 'tool calling ACTIVE' : 'using text tags');
});
