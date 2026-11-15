# Credits

## Car

"Car Concept" by Eric Chadwick, © 2024 Darmstadt Graphics Group GmbH, from the
[Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept).
Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Changes: the Khronos and 3D Commerce logos were removed and the number plate
was replaced. `public/assets/car/concept_car.glb` is the original model with
its pictures compressed (see below); the other changes are made when the game
loads it. `concept_car_lod.glb` is a simplified
copy (no interior, fewer triangles, smaller textures) made by
`tools/make-lod.mjs` for traffic and parked cars.

## Sky and surfaces

From [Poly Haven](https://polyhaven.com), all CC0 (public domain):

- Sky: kloofendal_38d_partly_cloudy_puresky (sun brightness reduced)
- Grass: rocky_terrain_02
- Rock: aerial_rocks_02
- Road: asphalt_02
- Pavement and roofs: square_concrete_pavers
- Walls: white_plaster_02, red_brick_03
- Bark: bark_brown_02
- Sand and beaches: coast_sand_01
- Pyramids, clock tower and Tower Bridge: sandstone_blocks_04
- Leaves: from the jacaranda_tree and fir_tree_01 models

## Made by the game itself

The landmarks, town buildings, people, bridges, sea ripples and all sounds
are generated in code; there are no outside files for them.

## Engine

Made with [Babylon.js](https://www.babylonjs.com) (Apache 2.0).

## Picture compression

Most pictures are stored as KTX2 files so they stay small in graphics memory.
They are made by `tools/compress-textures.mjs` with the
[Basis Universal](https://github.com/BinomialLLC/basis_universal) encoder
(Apache 2.0, © Binomial LLC), via the `ktx2-encoder` package (MIT). The game
unpacks them with Babylon.js's KTX2 reader, which includes Basis Universal and
Zstandard (BSD); those files are in `public/assets/ktx2/` with their licence.
