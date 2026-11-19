# Avatar artwork

`eyes.webp` is an original transparent 4 × 2 eye atlas generated for this project with OpenAI image generation, then encoded losslessly as WebP. Rows contain round, sparkling, cat and sleepy eyes; each column is one side. The artwork uses neutral irises, dark lashes, white sclera and small catchlights. `avatar-data/eyes.json` records the crops and iris registration; `eyeArtwork.ts` recolours only the iris and preserves the ink and highlights. Expressions and closed eyes remain procedural.

All hair, head, clothing and armor geometry is authored in this repository. Hair uses solid curved locks; flowing styles have a continuous rear volume, while Madara uses three overlapping layers of outward-pointing rear locks. Shape and appearance settings live in `avatar-data/`. No generated hair sheets or third-party photographs are shipped.

Visual references:

- SullyOS character editor: component-based editing, independent front/back hair structure and a rotating preview. Its code and assets are not copied.
- [Good Smile Company: Nendoroid Madara Uchiha](https://www.goodsmile.com/ja/product/12052/ねんどろいど+うちはマダラ): wide asymmetrical fringe covering one eye, layered dark rear hair and a fan of crown spikes. The reference photograph is not bundled.
- [MegaHouse: G.E.M. Madara Uchiha](https://en.megahobby.jp/products/g-e-m-series-naruto-shippuden-madara-uchiha): side and rear references for the outward-pointing, staggered rear hair silhouette. The reference photographs are not bundled.
