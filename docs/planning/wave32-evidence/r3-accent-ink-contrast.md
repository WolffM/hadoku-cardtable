# R3: --accent as text, contrast before and after (worst of page bg and card bg, WCAG ratio)

Source: @wolffm/themes style.css, computed by the measure in apps/ui/src/screens/tokens.test.ts.
before = the raw accent (--color-primary); after = --accent-ink = color-mix(in srgb, accent 35%, ink).

light            before 4.94  after 11.68
dark             before 8.28  after 11.77
strawberry-light before 2.51  after 8.50
strawberry-dark  before 6.29  after 10.69
ocean-light      before 2.28  after 5.26
ocean-dark       before 3.90  after 6.24
cyberpunk-light  before 3.68  after 11.35
cyberpunk-dark   before 9.79  after 12.84
coffee-light     before 3.43  after 10.34
coffee-dark      before 4.26  after 9.09
lavender-light   before 2.46  after 8.05
lavender-dark    before 5.95  after 10.71
pink-light       before 2.56  after 6.81
pink-dark        before 5.98  after 10.15
nature-light     before 2.15  after 6.69
nature-dark      before 5.48  after 9.66
izakaya-light    before 1.56  after 4.93
izakaya-dark     before 6.43  after 9.78
