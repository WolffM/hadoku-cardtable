"""Write round7.json (2026-10-12): every cell and role still empty, new Colourless and Boros lands, and a second
take for every sound heard often.

The operator: *"'colorless land, boros land' need new sounds ... fill the remaining gaps and also create more
sounds for the most common ones until i have at least two for each of the common ones like basic lands and stuff
that is heard often"*. "Often" is `played.py`'s count per game, and every interface sound (the tally that would
measure those had not run a game yet). A common sound's prompts are siblings of the take already placed on it, so a
second take sits beside the first instead of replacing its character. What earlier rounds taught (README, Round 6):
literal real-world sources, a different source per cell, no bells or chimes, short and simple for quick sounds.

    python3 scripts/sfx/make-round7.py
"""
import json
import os

QUICK = 1.0  # seconds generated for a sound that answers a gesture or ticks by often: shorter takes, simpler sounds

ROLES = {
    # interface: quick and soft
    'ui.hover-card': ('Interface', 'Hover a card', QUICK, [
        'A faint soft breath of air across paper, very gentle',
        'The softest brush of a fingertip over a smooth card',
        'A quiet low whoosh of a hand passing over a table, barely there']),
    'ui.hover-control': ('Interface', 'Hover a button', QUICK, [
        'A tiny soft tick of a wooden bead, very quiet',
        'A faint muted tap of a fingertip on felt',
        'A tiny soft click of a small wooden button']),
    'ui.select': ('Interface', 'Select', QUICK, [
        'One clean click of a small brass switch',
        'A crisp single click of a wooden toggle',
        'A short neat click of a small metal clasp']),
    'ui.lift': ('Interface', 'Pick up a card', QUICK, [
        'A playing card slid off a felt table and lifted, a soft scrape',
        'A single card picked up between two fingers, a light paper flick',
        'A card peeled up from a wooden table, short and soft']),
    'ui.place': ('Interface', 'Put a card down', QUICK, [
        'A playing card set flat on a felt table, a soft pat',
        'A card laid down on a wooden table, a light dry tap',
        'A card dropped a short way onto cloth, a muffled slap']),
    'ui.deny': ('Interface', 'Refused', QUICK, [
        'A dull low knock on a wooden table, once',
        'A short muted thunk of a wooden drawer stopping',
        'A soft low double tap of a knuckle on wood']),
    'ui.pass': ('Interface', 'Pass / OK', QUICK, [
        'Two soft knocks of knuckles on a wooden table',
        'One soft knock on a thick wooden table',
        'Two light taps of a fingertip on a wooden table']),
    'ui.prompt': ('Interface', 'Decision needed', QUICK, [
        'A single soft tap of a small wooden mallet on a wooden block',
        'One low hollow knock on a wooden box',
        'A gentle single tap on a hollow wooden log']),
    'ui.inspect': ('Interface', 'Inspect', QUICK, [
        'A card turned over in the hand, a short soft swish',
        'A short light paper flutter, a card raised',
        'A soft quick swish of a page turned']),
    'ui.target': ('Interface', 'Target locks', QUICK, [
        'A small metal latch clicking shut, crisp',
        'A crossbow string locked into place, one click',
        'A short sharp click of a compass lid closing']),
    # casting and the stack
    'g.cast.creature': ('Casting and the stack', 'Cast a creature', 1.5, [
        'A leather glove gripping tight and a soft low thump',
        'A heavy leather pouch set down on a table, a soft thud',
        'A rope pulled taut with a creak and a soft knock']),
    'g.cast.instant': ('Casting and the stack', 'Cast an instant', 1.5, [
        'A quick snap of fingers and a short swish of air',
        'A fast flick of a card through the air',
        'A short sharp whip crack, far and light']),
    'g.cast.sorcery': ('Casting and the stack', 'Cast a sorcery', 2.0, [
        'A heavy book slammed shut on a table',
        'A thick old book opened fast, pages fanning',
        'A heavy wooden chest lid dropped shut']),
    'g.cast.planeswalker': ('Casting and the stack', 'Cast a planeswalker', 2.5, [
        'A heavy cloak swept around and boots landing on stone',
        'A large war drum struck once, deep and close',
        'A heavy iron door slammed in a stone hall']),
    'g.ability': ('Casting and the stack', 'Ability', 1.5, [
        'A short rising whoosh ending in a soft click',
        'A quick lever pulled with a short mechanical clack',
        'A short rope pull through a pulley, one squeak']),
    'g.resolve': ('Casting and the stack', 'Resolves', 1.5, [
        'A soft release of air, a short falling whoosh that settles',
        'A cloth dropped softly onto a table',
        'A short soft exhale of a bellows']),
    # battlefield
    'g.land': ('On the battlefield', 'Play a land', 1.5, [
        'A boot stepping firmly onto packed earth',
        'A flat stone set down on the ground, one dull knock',
        'A handful of soil dropped onto the ground']),
    'g.creature': ('On the battlefield', 'Creature voice', 1.5, [
        'A short low animal huff, one breath through the nose',
        'A large animal snorting once',
        'A brief low growl from a big dog, one breath']),
    'g.enter': ('On the battlefield', 'Hits the table', 1.5, [
        'A heavy wooden block set down on a table, one deep thud',
        'A thick book dropped flat onto a wooden table',
        'A heavy stone set down on wood, one solid knock']),
    'g.tap': ('On the battlefield', 'Tap', QUICK, [
        'A light fingertip tap on a card, a short paper slide',
        'A playing card turned sideways on felt, a tiny scrape',
        'A soft single tap on a thick card']),
    'g.untap': ('On the battlefield', 'Untap', QUICK, [
        'A playing card straightened on felt, a tiny soft scrape',
        'A soft short paper slide, a card turned upright',
        'A light flick of a card edge on a table']),
    'g.counter-on': ('On the battlefield', 'Counter added', QUICK, [
        'A small glass bead set down on wood, one tick',
        'A small bone die set down on a table, one click',
        'A small stone counter placed on wood, one tap']),
    'g.counter-off': ('On the battlefield', 'Counter removed', QUICK, [
        'A small glass bead picked up off wood, a short scrape',
        'A small die slid off a table into a palm',
        'A small stone counter lifted, a soft hollow pop']),
    'g.mana': ('On the battlefield', 'Mana', QUICK, [
        'A small spark struck from flint, one crackle',
        'A water droplet falling into a still pool',
        'A small ember popping in a fire']),
    'g.transform': ('On the battlefield', 'Transform', 2.0, [
        'A heavy cloth cloak swept around fast',
        'A wolf growl rising out of a breath',
        'Stone cracking open, one sharp split']),
    # cards moving
    'g.shuffle': ('Cards moving', 'Shuffle', 1.5, [
        'A short riffle shuffle of a deck of cards',
        'A deck of cards bridged and cascading together',
        'A quick overhand shuffle of cards, soft paper slaps']),
    'g.dies': ('Cards moving', 'Creature dies', 1.5, [
        'A last low breath and a soft heavy thud',
        'A body falling onto straw, a soft heavy thump',
        'A heavy sack dropped onto a wooden floor']),
    'g.destroy': ('Cards moving', 'Destroyed', 1.5, [
        'A wooden plank snapping in two',
        'A clay pot breaking on stone',
        'A small wooden crate crushed, one crunch']),
    'g.exile': ('Cards moving', 'Exile', 1.5, [
        'A short airy whoosh of something pulled away into nothing',
        'A candle snuffed out with a soft puff',
        'A cloth pulled off a table in one fast swish']),
    'g.discard': ('Cards moving', 'Discard', QUICK, [
        'A card flicked away across a table, a quick swish',
        'A card tossed onto a pile of cards, a light slap',
        'A crumpled piece of paper tossed onto a table']),
    'g.mill': ('Cards moving', 'Mill', 1.5, [
        'A few cards sliding off a deck onto a pile',
        'A handful of pages torn from a book',
        'A short slide of a stack of cards spilling']),
    # combat and life
    'g.attack': ('Combat and life', 'Attack', 1.5, [
        'A sword drawn from a leather scabbard, short scrape',
        'An axe lifted off a wooden rack',
        'A spear tip scraped along stone']),
    'g.block': ('Combat and life', 'Block', 1.5, [
        'A wooden shield blocking a sword, one heavy knock',
        'Two staffs clashing once, wooden crack',
        'A metal shield bash, one dull clang']),
    'g.lifegain': ('Combat and life', 'Life gain', 2.0, [
        'A deep relieved breath in and out',
        'A warm campfire flaring up with a soft whoosh',
        'Water poured from a jug into a wooden cup']),
    # turn and game
    'g.game-start': ('Turn and game', 'Coin toss', 2.5, [
        'A coin flipped high, spinning and landing on a wooden table',
        'A coin spun on a wooden table until it falls flat',
        'A heavy coin tossed and caught in a hand']),
    'g.turn-mine': ('Turn and game', 'Your turn', 2.5, [
        'A wooden door opening onto a breezy courtyard',
        'An hourglass turned over on a wooden table, sand starting to pour',
        'A deep breath in and a chair pulled up to a table']),
    'g.turn-theirs': ('Turn and game', 'Their turn', 2.5, [
        'An hourglass set down on a wooden table, sand trickling',
        'A chair pushed back from a wooden table',
        'A heavy wooden door closing softly in another room']),
    'g.phase': ('Turn and game', 'Phase change', QUICK, [
        'A single soft wooden click',
        'A soft tick of a wooden counter slid on a rail',
        'A page corner flipped, one soft tick']),
    'g.token': ('On the battlefield', 'Token appears', QUICK, [
        'A small wooden token set on a table, one bright tap',
        'A cardboard chip flicked onto felt, one soft clack',
        'A small clay figure set on wood, one knock']),
}

# A cell's prompts carry its place: the identity's own sources, different from what that row's other cells use.
COLOURS = {
    # the operator named these two
    'C|land': ('Lands', 'Colourless land', [
        'Heavy stone blocks grinding into place in an old ruin',
        'A metal gate in a stone wall swinging shut, an echo',
        'Wind through a hollow stone monolith, a low hum']),
    'RW|land': ('Lands', 'Boros land', [
        'Soldiers marching through a city gate, boots on cobblestone',
        'A blacksmith forge roaring as bellows pump',
        'A war banner snapping in a strong wind on a stone wall']),
    # still empty
    'W|creature': ('White', 'White creature', [
        'A horse whinny and hooves stamping on packed earth',
        'A lion roaring once on open grassland',
        'An eagle crying overhead with a beat of wings']),
    'U|spell': ('Blue', 'Blue spell', [
        'A wave drawn back over pebbles and crashing',
        'A water drop into a deep cave pool, a hollow plunk',
        'A gust of sea wind over open water']),
    'U|creature': ('Blue', 'Blue creature', [
        'A seal barking on a rocky shore',
        'A heron croaking and taking off from the water',
        'A whale blowing through its blowhole, a deep spray']),
    'UB|land': ('Lands', 'Dimir land', [
        'Water dripping in a stone sewer tunnel',
        'A heavy iron grate dragged over wet stone',
        'A rat scurrying through a dark tunnel']),
    'R|creature': ('Red', 'Red creature', [
        'A wild boar squealing and grunting',
        'A large lizard hissing with a burst of fire',
        'A goat bleating on a rocky cliff, pebbles falling']),
    'WB|spell': ('Orzhov', 'Orzhov spell', [
        'Coins poured onto a stone table',
        'A heavy vault lock turning, one clunk',
        'A wax seal pressed onto parchment']),
    'RGW|land': ('Lands', 'Naya land', [
        'Jungle birds calling with insects buzzing',
        'A waterfall pouring into a jungle pool',
        'Huge footsteps shaking the ground in a jungle']),
    'URW|creature': ('Jeskai', 'Jeskai creature', [
        'A hawk diving with a sharp cry',
        'A wooden staff spun fast through the air',
        'A crane flapping its wings and calling']),
    'URW|land': ('Lands', 'Jeskai land', [
        'Prayer flags flapping in mountain wind',
        'A mountain stream rushing over rocks',
        'A wooden temple door sliding shut']),
    'RWB|land': ('Lands', 'Mardu land', [
        'A campfire crackling with war drums in the distance',
        'Tent canvas flapping in strong wind',
        'Horses snorting and stamping in a camp']),
    'WUBRG|creature': ('Four colours or more', 'Five-colour creature', [
        'A huge mythical beast roaring with wings beating',
        'A dragon landing heavily and folding its wings',
        'A great beast stamping and roaring in a cave']),
    # heard often, one take so far
    'W|basic': ('Basic lands', 'Plains', [
        'A footstep onto open plains, warm wind over grass',
        'Wind sweeping through a wheat field',
        'A horse trotting over a grassy meadow']),
    'U|basic': ('Basic lands', 'Island', [
        'Waves lapping on a sandy beach, field recording',
        'A wave rolling onto a pebble beach',
        'Seagulls over a calm shore with soft surf']),
    'B|basic': ('Basic lands', 'Swamp', [
        'Mud bubbling in a swamp, a frog croaking',
        'Boots squelching in deep mud',
        'A slow bog bubbling with insects buzzing']),
    'R|basic': ('Basic lands', 'Mountain', [
        'Rocks and gravel tumbling down a slope',
        'A boulder rolling and cracking against rock',
        'Wind howling over a rocky mountain ridge']),
    'G|basic': ('Basic lands', 'Forest', [
        'Leaves rustling and branches creaking in a forest',
        'Footsteps on dry leaves and twigs in a forest',
        'Birds singing in a deep forest, leaves rustling']),
    'C|artifact': ('Colourless', 'Colourless artifact', [
        'An iron key turned in an old lock, short clunk',
        'A brass padlock snapped shut',
        'A heavy iron hinge creaking once']),
    'R|spell': ('Red', 'Red spell', [
        'A fast fiery whoosh into crackling sparks',
        'A torch thrust into flames, a roaring flare',
        'A firework fuse hissing and popping']),
    'G|spell': ('Green', 'Green spell', [
        'Leaves swirling in a warm gust of wind',
        'Vines creaking and snapping as they grow',
        'A tree branch swaying and rustling']),
    'G|creature': ('Green', 'Green creature', [
        'A bear growling, deep and close',
        'A stag bellowing in a forest',
        'A wolf snarling, low and close']),
    'UR|land': ('Lands', 'Izzet land', [
        'A close thunder crack and a rolling boom',
        'Electric sparks crackling from a coil',
        'Steam hissing from a brass pipe']),
    'RG|land': ('Lands', 'Gruul land', [
        'War drums pounding in a canyon',
        'A herd of large animals stampeding over rock',
        'A huge rock split by a heavy blow']),
    'WU|land': ('Lands', 'Azorius land', [
        'A heavy stone door closing in a marble hall',
        'A fountain splashing in a stone plaza',
        'Footsteps echoing in a marble courtroom']),
    'W|spell': ('White', 'White spell', [
        'A bright brass horn call, short',
        'A strong warm wind gust over a sunlit field',
        'A sword raised and shining, a soft metallic shing']),
    'B|spell': ('Black', 'Black spell', [
        'A low cold breath in a stone crypt',
        'Bones rattling in a wooden coffin',
        'A raven cawing once in the dark']),
    'B|creature': ('Black', 'Black creature', [
        'A low snarl and rattling bones',
        'A bat screeching with wings flapping',
        'A large rat hissing']),
    'R|land': ('Lands', 'Red land', [
        'Lava bubbling and hissing',
        'A volcanic vent hissing steam',
        'Fire crackling in a stone forge']),
    'U|land': ('Lands', 'Blue land', [
        'An ocean wave crashing on a rocky shore',
        'A tide pool draining over rocks',
        'Rain falling onto a calm lake']),
    'B|land': ('Lands', 'Black land', [
        'Crows cawing over a graveyard',
        'An iron cemetery gate creaking open',
        'Water dripping in a stone crypt']),
    'W|land': ('Lands', 'White land', [
        'A footstep onto open plains, warm wind over grass',
        'A sunlit meadow with birds and wind',
        'Wind over a field of tall grass']),
    'BR|land': ('Lands', 'Rakdos land', [
        'A fireball flying past and exploding',
        'Chains rattling over a crackling fire',
        'A furnace door clanging open, fire roaring']),
}


def main():
    sounds = {}
    for rid, (group, name, seconds, prompts) in ROLES.items():
        sounds[rid] = {'group': group, 'name': name, 'seconds': seconds, 'prompts': prompts}
    basic = {'W': 'land-plains', 'U': 'land-island', 'B': 'land-swamp', 'R': 'land-mountain', 'G': 'land-forest'}
    for cell, (group, name, prompts) in COLOURS.items():
        row, paradigm = cell.split('|')
        folder = basic[row] if paradigm == 'basic' else f'{row.lower()}.{paradigm}'
        sounds[folder] = {'group': group, 'name': name, 'prompts': prompts}
    spec = {
        'note': 'Round 7 (2026-10-12): see make-round7.py.',
        'suffix': 'High-quality, stereo, 44.1kHz, sound effect, close-mic.',
        'negative': 'low quality, muffled, lo-fi, hiss, distortion, clipping, bell, bells, chime, chimes, gong, '
                    'glockenspiel, music, melody, song, speech, voice, vocals, singing, harsh, shrill',
        'seconds': 2.5,
        'sounds': sounds,
    }
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'round7.json')
    json.dump(spec, open(out, 'w'), indent=1, ensure_ascii=False)
    print(f"{len(sounds)} sounds, {sum(len(s['prompts']) for s in sounds.values())} prompts -> {out}")


if __name__ == '__main__':
    main()
