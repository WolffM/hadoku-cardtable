"""Write round5.json: new candidates for the cells the operator's passes left empty (2026-10-11).

The operator had heard every take in the catalogue and kept 96: "get rid of everything that isn't used
and then create new ones to fill the gaps". What the keepers say, and what every prompt here follows:
- a role is a short, dry, close-mic single hit (the kept draws, taps, shuffles are all "clean, dry,
  close, one shot"); the kept colour sounds are evocative scenes ("a gavel knock and a precise crystal
  chime", "electric arcs, sparks and a rising synth zap");
- no tails and no second hits: their edits cut an instant to its first snap, a counter to its first
  half, and the bell they kept is one strike.

    python3 scripts/sfx/make-round5.py <empty.json>   # {roles: [...], colours: [...]} from the live assignments
"""
import json
import os
import sys

ROLE_PROMPTS = {
    'ui.hover-card': ['Faint fingertip brush across a playing card, the softest paper whisper',
                      'Barely there tick of a fingernail on smooth cardstock',
                      'Tiny soft paper rustle, a card edge grazed'],
    'ui.hover-control': ['Tiny soft wooden tick, a bead tapped once',
                         'Faint muted click of a small brass button',
                         'Very soft felt tap on a wooden table'],
    'ui.select': ['Crisp small wooden click, a game token set down once',
                  'Short bright tap of a stone counter on wood',
                  'Clean single click of a brass toggle'],
    'ui.prompt': ['One soft low wooden knock, attentive and calm',
                  'A single gentle mallet tap on a small wooden block',
                  'Soft short pluck of one low harp string'],
    'ui.inspect': ['Soft quick paper lift, a card raised toward the eye',
                   'Short airy swish of a card turned over in the hand',
                   'Gentle magnifying glass set on a card, a soft glassy tap'],
    'g.cast.sorcery': ['A card snapped onto the table with a short dry whoosh of magic',
                       'Quick paper flick into a soft low arcane thump',
                       'A spell card slapped down, a brief dark swell that stops'],
    'g.cast.enchantment': ['A card laid down with a soft glassy shimmer that settles',
                           'Gentle paper slide into a short warm bell-like glow',
                           'A card placed softly, a quiet sparkle of dust'],
    'g.cast.planeswalker': ['A card slammed down with a deep resonant boom, short and weighty',
                            'A heavy card drop into a brief rising choir hit, cut short',
                            'Powerful single drum hit with a metallic ring, one strike'],
    'g.land': ['A playing card set firmly on a wooden table, one solid tap',
               'A thick card placed down with a short dull knock',
               'A card dropped flat on felt, a soft heavy pat'],
    'g.creature': ['A short low creature grunt, a single breath',
                   'A brief beastly huff, one exhale',
                   'A quick low growl that stops at once'],
    'g.enter': ['A heavy card lands on a wooden table, one deep thud',
                'Solid single thump of a game piece set down hard',
                'A short weighty knock on thick wood'],
    'g.token': ['A small light wooden token placed on a table, a bright tap',
                'A tiny glass bead dropped on wood, a single tink',
                'A cardboard chip flicked onto felt, one soft clack'],
    'g.counter-on': ['A small plastic die set on a card, one crisp click',
                     'A single coin placed on wood, a short bright clink',
                     'A tiny wooden bead clicked into place'],
    'g.counter-off': ['A small die lifted off a card, a short soft scrape',
                      'A coin slid off a table into a hand, a brief metallic swish',
                      'A wooden bead pulled away, a soft hollow pop'],
    'g.transform': ['A card flipped over fast with a short magical swish',
                    'A quick paper flip into a brief shimmering whoosh',
                    'A card turned with a snap and a short rising sweep'],
    'g.mana': ['A short soft crystal ping, one note',
               'A single small glass chime, bright and short',
               'A quick soft energy pulse, a gentle hum that stops'],
    'g.destroy': ['A card torn quickly in half, one sharp rip',
                  'A brittle object cracking and crumbling, a short break',
                  'A wooden piece snapped, one dry crack'],
    'g.exile': ['A short airy vanishing whoosh, something pulled into nothing',
                'A quick reversed shimmer that disappears',
                'A brief hollow swish of something sucked away'],
    'g.bounce': ['A card swept off the table back into a hand, a quick paper slide',
                 'A short rubbery boing, a light bounce',
                 'A quick reversed paper flick, a card returned'],
    'g.mill': ['A few cards slid off a deck in a quick paper cascade',
               'A short shuffle of three cards dropped onto a pile',
               'Quick flutter of cards falling onto a table'],
    'g.lifegain': ['A short warm rising chime, one gentle shimmer',
                   'A brief soft harp glissando up, cut short',
                   'A single warm bell tone with a soft glow'],
    'g.turn-theirs': ['One soft distant low bell strike, calm',
                      'A single muted gong tap, low and short',
                      'A soft low wooden chime, one note, further away'],
}

ROLE_SECONDS = {r: 1.5 for r in ROLE_PROMPTS if r.startswith('ui.')}

# What each identity is, in sound. Mono colours have their own; a combination has its own theme.
THEME = {
    'W': 'radiant and orderly: bright brass, a clear bell, sunlight',
    'U': 'cool and clever: water, wind, glassy tones',
    'B': 'shadowy and hungry: a low drone, bones, a dark breath',
    'R': 'hot and impulsive: fire, sparks, a crackling burst',
    'G': 'wild and growing: wood, leaves, a deep animal rumble',
    'WU': 'law and order: a gavel knock and a precise crystal chime',
    'UB': 'secrets and shadow: a hushed whisper of wind and a cold glassy tone',
    'BR': 'a dark carnival: a crackle of fire and a rattling chain',
    'RG': 'savage stomping: a heavy footfall, cracking rock and a roar',
    'GW': 'a living choir: rustling leaves and a warm swell of voices',
    'WB': 'a grand church of coin: a deep bell and clinking gold',
    'UR': 'mad science: electric arcs and a rising synth zap',
    'BG': 'rot and regrowth: a wet fungal squelch and creaking roots',
    'RW': 'a war legion: a war horn blast and clashing steel',
    'GU': 'mutation: wet organic morphing and bubbling water',
    'GWU': 'shining knights: a bright horn and armour in sunlight',
    'WUB': 'etherium and glass: a cold metallic chime and a clockwork tick',
    'UBR': 'an undead wasteland: an eerie drone, a ghostly glide and embers',
    'BRG': 'dragons and volcanoes: a lava rumble and a dragon roar',
    'RGW': 'giant beasts in the jungle: a huge roar and pounding drums',
    'WBG': 'the desert endures: wind over sand and a low solemn hum',
    'URW': 'monks and wind: a quick whoosh, wind chimes and a gong',
    'BGU': 'a great serpent: scales sliding, a hiss and a wet rustle',
    'RWB': 'a war horde: galloping horses and clanking armour',
    'GUR': 'savagery and ice: an icy shimmer, a roar and cracking frost',
    'WUBRG': 'every colour at once: a prismatic shimmer, five tones in a bright chord',
    'C': 'colourless and ancient: humming stone, metal and a mechanical whirr',
}
TERRAIN = {
    'W': 'open plains, warm wind over grass', 'U': 'an island shore, one lapping wave',
    'B': 'a dark swamp, a slow bubbling bog', 'R': 'a mountain, rumbling rock and gravel',
    'G': 'a deep forest, rustling leaves and creaking wood', 'C': 'an ancient stone monument, a resonant hum',
}
BASIC = {'W': 'land-plains', 'U': 'land-island', 'B': 'land-swamp', 'R': 'land-mountain', 'G': 'land-forest'}


def colour_prompts(row, paradigm):
    theme = THEME[row]
    if paradigm == 'spell':
        return [f'A spell is cast, {theme}', f'A quick magical burst, {theme}']
    if paradigm == 'creature':
        return [f'A creature arrives, {theme}', f'A creature steps in with one call, {theme}']
    if paradigm == 'artifact-creature':
        return ['A metal construct powers up, joints clanking and a short mechanical whirr',
                'A clockwork golem steps forward, one heavy metal clank and a gear spin']
    terrain = ' and '.join(TERRAIN[c] for c in ('C' if row == 'C' else row)) if len(row) <= 2 else theme
    if paradigm == 'basic':
        return [f'A land is played: {TERRAIN[row]}', f'Footstep onto {TERRAIN[row]}']
    return [f'A land is played: {terrain}', f'A land settles into place, {theme}']


def main():
    empty = json.load(open(sys.argv[1]))
    sounds = {}
    for r in empty['roles']:
        sounds[r['id']] = {'group': r['group'], 'name': r['name'], 'prompts': ROLE_PROMPTS[r['id']],
                           **({'seconds': ROLE_SECONDS[r['id']]} if r['id'] in ROLE_SECONDS else {})}
    for c in empty['colours']:
        row, p = c['row'], c['paradigm']
        folder = BASIC[row] if p == 'basic' else f"{row.lower()}.{p}"
        land = p in ('land', 'basic')
        name = {'W': 'Plains', 'U': 'Island', 'B': 'Swamp', 'R': 'Mountain', 'G': 'Forest'}[row] if p == 'basic' \
            else f"{c['name']} {p.replace('-', ' ')}"
        sounds[folder] = {'group': ('Basic lands' if p == 'basic' else 'Lands') if land else c['name'], 'name': name,
                          'section': 'Land types' if land else 'Colour sounds', 'prompts': colour_prompts(row, p)}
    spec = {
        'note': 'Round 5 (2026-10-11): the cells left empty after the operator heard every earlier take. See make-round5.py.',
        'suffix': 'Fantasy card game sound effect, one single hit, dry, close-mic, no reverb, no echo, short clean ending. '
                  'High-quality, stereo, 44.1kHz.',
        'negative': 'low quality, muffled, lo-fi, noise, hiss, distortion, clipping, music, melody, speech, voice, vocals, '
                    'reverb, echo, delay, long tail, repeated hits, double hit, two sounds',
        'seconds': 3.0,
        'sounds': sounds,
    }
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'round5.json')
    json.dump(spec, open(out, 'w'), indent=1, ensure_ascii=False)
    print(f"{len(sounds)} sounds, {sum(len(s['prompts']) for s in sounds.values())} prompts -> {out}")


if __name__ == '__main__':
    main()
