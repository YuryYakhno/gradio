# @gradio/tabitem

## 0.2.2

### Fixes

- [#7220](https://github.com/gradio-app/gradio/pull/7220) [`3b8dfc6`](https://github.com/gradio-app/gradio/commit/3b8dfc684dc0eb0544d06300fa546b23f587c63f) - Add `visible` check to Tab.  Thanks [@hannahblair](https://github.com/hannahblair)!

## 0.2.1

### Patch Changes

- Updated dependencies [[`5727b92`](https://github.com/gradio-app/gradio/commit/5727b92abc8a00a675bfc0a921b38de771af947b), [`80f8fbf`](https://github.com/gradio-app/gradio/commit/80f8fbf0e8900627b9c2575bbd7c68fad8108544)]:
  - @gradio/utils@0.2.1
  - @gradio/tabs@0.2.1

## 0.2.0

### Features

- [#7018](https://github.com/gradio-app/gradio/pull/7018) [`ec28b4e`](https://github.com/gradio-app/gradio/commit/ec28b4e7c47a9233d9e3a725cc9fe8f9044dfa94) - Add `visible` and `interactive` params to `gr.Tab()`. Thanks [@hannahblair](https://github.com/hannahblair)!

## 0.1.0

### Features

- [#5498](https://github.com/gradio-app/gradio/pull/5498) [`287fe6782`](https://github.com/gradio-app/gradio/commit/287fe6782825479513e79a5cf0ba0fbfe51443d7) - Publish all components to npm. Thanks [@pngwn](https://github.com/pngwn)!

## 0.1.0-beta.8

### Patch Changes

- Updated dependencies [[`667802a6c`](https://github.com/gradio-app/gradio/commit/667802a6cdbfb2ce454a3be5a78e0990b194548a)]:
  - @gradio/utils@0.2.0-beta.6
  - @gradio/tabs@0.1.0-beta.8

## 0.1.0-beta.7

### Features

- [#6016](https://github.com/gradio-app/gradio/pull/6016) [`83e947676`](https://github.com/gradio-app/gradio/commit/83e947676d327ca2ab6ae2a2d710c78961c771a0) - Format js in v4 branch. Thanks [@freddyaboulton](https://github.com/freddyaboulton)!

## 0.1.0-beta.6

### Features

- [#5960](https://github.com/gradio-app/gradio/pull/5960) [`319c30f3f`](https://github.com/gradio-app/gradio/commit/319c30f3fccf23bfe1da6c9b132a6a99d59652f7) - rererefactor frontend files. Thanks [@pngwn](https://github.com/pngwn)!
- [#5938](https://github.com/gradio-app/gradio/pull/5938) [`13ed8a485`](https://github.com/gradio-app/gradio/commit/13ed8a485d5e31d7d75af87fe8654b661edcca93) - V4: Use beta release versions for '@gradio' packages. Thanks [@freddyaboulton](https://github.com/freddyaboulton)!

## 0.0.6

### Patch Changes

- Updated dependencies []:
  - @gradio/utils@0.1.2
  - @gradio/tabs@0.0.7

## 0.0.5

### Features

- [#5590](https://github.com/gradio-app/gradio/pull/5590) [`d1ad1f671`](https://github.com/gradio-app/gradio/commit/d1ad1f671caef9f226eb3965f39164c256d8615c) - Attach `elem_classes` selectors to layout elements, and an id to the Tab button (for targeting via CSS/JS). Thanks [@abidlabs](https://github.com/abidlabs)!

## 0.0.4

### Patch Changes

- Updated dependencies []:
  - @gradio/utils@0.1.1
  - @gradio/tabs@0.0.5

## 0.0.3

### Patch Changes

- Updated dependencies [[`abf1c57d`](https://github.com/gradio-app/gradio/commit/abf1c57d7d85de0df233ee3b38aeb38b638477db)]:
  - @gradio/utils@0.1.0
  - @gradio/tabs@0.0.4

## 0.0.2

### Highlights

#### Improve startup performance and markdown support ([#5279](https://github.com/gradio-app/gradio/pull/5279) [`fe057300`](https://github.com/gradio-app/gradio/commit/fe057300f0672c62dab9d9b4501054ac5d45a4ec))

##### Improved markdown support

We now have better support for markdown in `gr.Markdown` and `gr.Dataframe`. Including syntax highlighting and Github Flavoured Markdown. We also have more consistent markdown behaviour and styling.

##### Various performance improvements

These improvements will be particularly beneficial to large applications.

- Rather than attaching events manually, they are now delegated, leading to a significant performance improvement and addressing a performance regression introduced in a recent version of Gradio. App startup for large applications is now around twice as fast.
- Optimised the mounting of individual components, leading to a modest performance improvement during startup (~30%).
- Corrected an issue that was causing markdown to re-render infinitely.
- Ensured that the `gr.3DModel` does re-render prematurely.

Thanks [@pngwn](https://github.com/pngwn)!