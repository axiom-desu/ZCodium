# CUA runtime distribution

ZCodium distributes the npm packages `@trycua/cua-driver` and the
selected `@trycua/cua-driver-<platform>` native package, version **0.28.2**,
together with `@ubjs/core` and `@ubjs/node`, version **0.31.0-3**.
No proprietary ZCode binaries are included in this runtime.

CUA SDK source, including the compatibility runtime build transformations:
https://github.com/trycua/cua/tree/fc188250b4ca8549b8e61f937fdb1fb560770e86/libs/cua-driver
Release tag: `cua-driver-rs-v0.28.2`.

The native `cua_driver_node_runtime.node` is a compatibility build derived
from `@ubjs/node` 0.31.0-3. The original source is available at the exact
npm-published revision (gitHead) and can be obtained from
https://github.com/jhugman/uniffi-bindgen-react-native/tree/dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449
(the corresponding `@ubjs/core` release points to
https://github.com/jhugman/uniffi-bindgen-react-native/tree/49bc59194d183a05855ed4104c18eb92fb465e02).
The CUA packager rebuilds the runtime from this source with the deterministic
compatibility build transformations in the pinned CUA release; packaging strips
source-map files and `sourceMappingURL` comments. This is a local packaging
transformation, not upstream source: original copyright and license notices are
retained, and this notice plus the full MPL text accompany the distribution.

## CUA — MIT

License source:
https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/LICENSE.md

MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ubjs / compatibility Node runtime — MPL-2.0

Copyright the uniffi-bindgen-react-native contributors. The original notice
at the source revision above reads:

This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at http://mozilla.org/MPL/2.0/

MPL-2.0 terms: https://www.mozilla.org/MPL/2.0/
The linked source remains available under MPL-2.0. Native runtime code is redistributed without local source changes; platform signing may update signature metadata. Packaging may
remove JavaScript source maps and sourceMappingURL comments; runtime behavior
and the original copyright and license notices are retained.
