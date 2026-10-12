"""Write round6.json: see its note. Every prompt is literal by hand; nothing here is templated, on purpose."""
import json
import os
NAMES={'W':'White','U':'Blue','B':'Black','R':'Red','WU':'Azorius','UB':'Dimir','BR':'Rakdos','RG':'Gruul','GW':'Selesnya','WB':'Orzhov','RW':'Boros','GWU':'Bant','RGW':'Naya','WBG':'Abzan','URW':'Jeskai','RWB':'Mardu','WUBRG':'Five colours'}
C={
 'W|creature':['Horse neighing and hooves stamping on packed earth','Eagle crying overhead with a beat of wide wings','Armoured knight kneeling, chain mail and plate shifting'],
 'U|spell':['A big ocean wave drawing back over pebbles and crashing','A water drop falling into a deep cave pool, hollow plunk','Strong sea wind gust, a sail snapping taut'],
 'U|creature':['Dolphin clicks and a splash at the surface','Heron croaking and wings flapping off the water','Whale blowing air through its blowhole, a deep spray'],
 'B|land':['Rusty iron cemetery gate creaking open','Crows cawing over a graveyard','Water dripping in a stone crypt'],
 'R|creature':['Ogre grunting with a heavy footstep on gravel','A burst of roaring flame from a fire breather','Mountain goat bleating with pebbles falling down a cliff'],
 'WU|land':['Heavy stone courthouse door closing in a marble hall','Fountain splashing in a stone city plaza','Pigeons fluttering off a high stone balcony in the wind'],
 'UB|land':['Water dripping in a stone sewer tunnel','Rats squeaking and scurrying through a tunnel','Heavy iron grate dragged across wet stone'],
 'BR|creature':['Hyena laughing','A demon growl over crackling fire','Heavy chains rattling and a large beast snorting'],
 'RG|creature':['Elephant trumpeting','Rhinoceros snorting and charging, heavy stomps','Wild boar grunting and rooting in the dirt'],
 'GW|spell':['Wind sweeping through a wheat field','A flock of birds taking off from a tree all at once','Tree branches creaking and leaves rushing in the wind'],
 'GW|land':['A gentle brook over pebbles in a meadow','Bees buzzing around flowers in a garden','Tall grass brushed aside by footsteps'],
 'WB|spell':['Coins poured onto a stone table','A heavy vault door lock turning and clunking','A quill scratching on parchment then a wax seal pressed'],
 'WB|land':['A large cathedral door creaking open','Footsteps echoing in a marble crypt','Coins dropped into a wooden collection box'],
 'RW|creature':['Soldiers marching in step on stone','Horse rearing and neighing','Griffin screech with heavy wing beats'],
 # Bant: the operator, 2026-10-11 — "bant: harbour sounds"
 'GWU|spell':['A ship sail catching the wind and snapping taut','A foghorn across a harbour','A wave slapping against a wooden pier'],
 'GWU|creature':['Seagulls crying over a harbour','A seal barking on a dock','Horse hooves on wooden dock planks'],
 'GWU|land':['Water lapping against a stone harbour wall, mooring ropes creaking','A wooden ship hull creaking at anchor','A mooring rope thrown and pulled tight around a dock post'],
 'RGW|land':['Jungle ambience, exotic birds calling and insects','A waterfall pouring into a jungle pool','Giant footsteps shaking the ground in a jungle'],
 'WBG|creature':['Camel groaning','A large lizard hissing','Armoured footsteps on sand, scale mail rattling'],
 'URW|creature':['A hawk diving with a sharp cry','A wooden staff spun fast through the air','A crane flapping its wings and calling'],
 'URW|land':['Wind over a mountain monastery, prayer flags flapping','A waterfall down a mountain cliff','A wooden temple door sliding shut'],
 'RWB|land':['A campfire crackling with distant war drums','Tent canvas flapping in a strong wind','A blacksmith hammering on an anvil'],
 'WUBRG|creature':['A huge mythical beast roaring with wings beating','Many animals at once, birds, wolves and a lion','A dragon landing heavily, wings folding'],
 'WUBRG|land':['An earthquake rumble with crackling fire and rushing water','Wind, rain and thunder over open land','Rocks splitting and a geyser of water bursting up'],
}
R={
 'g.lifegain':('Combat and life','Life gain',['A deep relieved breath in and out','A slow strong heartbeat, two beats','Spring water bubbling up out of the ground','A campfire flaring up warmly, a soft whoosh','A cork popped and a liquid gulp','Leaves unfurling and a plant growing, soft rustle']),
 'g.turn-theirs':('Turn and game','Their turn',['An hourglass flipped over on a wooden table, sand starting to pour','A distant war horn, low and far away','A heavy wooden door closing softly in another room']),
 'g.match-start':('Turn and game','Game start',['A war horn blown, long and rising','Heavy wooden castle gates swinging open','A deck of cards cut, riffled and squared on a table','A big war drum roll building up']),
 'g.cast.sorcery':('Casting and the stack','Cast a sorcery',['Pages of a heavy book flipping fast then slammed shut','A torch whooshing to life','Parchment torn in half']),
 'g.cast.planeswalker':('Casting and the stack','Cast a planeswalker',['A thunderclap with a big gust of wind','A huge stone slab dropped, deep ground boom','A cape swept through a strong wind']),
 'g.land':('On the battlefield','Play a land',['A boot stepping onto gravel','A stone slab set down on stone','A handful of dirt dropped on the ground']),
 'g.transform':('On the battlefield','Transform',['A wolf growl with bones cracking','A heavy cloak swept around fast','Stone cracking open and crumbling']),
 'g.mana':('On the battlefield','Mana',['A small electric spark crackle','A water droplet into a still pool','An ember flaring from a fire']),
 'g.destroy':('Cards moving','Destroyed',['A wooden crate smashed apart','A glass bottle breaking on stone','A stone pillar crumbling']),
 'g.mill':('Cards moving','Mill',['Several cards sliding off a deck onto a pile','Sand poured onto stone','Pages ripped out of a book quickly']),
}
BASIC={'W':'Plains','U':'Island','B':'Swamp','R':'Mountain','G':'Forest'}
sounds={}
for cell,prompts in C.items():
    row,p=cell.split('|'); land=p=='land'
    sounds[f'{row.lower()}.{p}']={'group':'Lands' if land else NAMES[row],'name':f'{NAMES[row]} {p}','prompts':prompts}
for rid,(g,n,prompts) in R.items():
    sounds[rid]={'group':g,'name':n,'prompts':prompts}
spec={'note':'Round 6 (2026-10-11), written from what the operator placed: real-world field recordings were kept 8 of 9 times and rich specific scenes 39%, while the round 4/5 "one single hit, dry, close-mic" template was kept 6%, ethereal swells 1 of 90 and anything with a bell or chime 4 of 100. So: one concrete place per identity (Bant is a harbour), a different real source in every cell, the plain recording suffix, and bells, chimes and gongs refused. Written by make-round6.py.',
 'suffix':'High-quality, stereo, 44.1kHz, sound effect, field recording.',
 'negative':'low quality, muffled, lo-fi, hiss, distortion, clipping, bell, bells, chime, chimes, gong, glockenspiel, music, melody, song, speech, voice, vocals, singing',
 'seconds':3.0,'sounds':sounds}
json.dump(spec,open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'round6.json'),'w'),indent=1,ensure_ascii=False)
print(len(sounds),'sounds',sum(len(s['prompts']) for s in sounds.values()),'prompts')
