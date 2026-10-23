## Fixed

- **A big stack no longer slows the game to a crawl.** Every card waiting on the stack used to make
  the browser redraw its shadow on every frame. A Pyroclasm that put twenty-odd triggers on the
  stack dropped the game to about 7 frames a second. The cards still float and drift, and their
  shadow now holds still.
- **Big fights stay smooth.** When several creatures die or crash together, the dust, shards and
  rocks are now shared out among them instead of each throwing its full share. One creature dying
  looks exactly as it did. A four-creature pile-up looks about as busy as two, instead of putting
  over two hundred moving pieces on screen.
- **Flying creatures cost far less to draw.** Their gentle bob and tilt now move the way the browser
  handles best, so a board full of flyers no longer weighs on every frame. They look and move just
  as before, and the counters and badges on them stay right on the card.
- **Shroud's mist no longer redraws the card it covers on every frame.** The fog drifts across the
  card as it always did.
- **The board no longer makes the whole page work out its styles again on every change.** In a
  big attack, that work is now about half what it was.
