/** Item hero for shared screenshots/photos: one image, or a swipeable carousel for several. */
import { type ReactNode, useState } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { T } from './components';
import { radius, space, useTheme } from './theme';

export function ImageHero({ uris, badge }: { uris: string[]; badge?: ReactNode }) {
  const { c } = useTheme();
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ borderRadius: radius.lg, overflow: 'hidden', backgroundColor: c.surfaceAlt, aspectRatio: 4 / 3 }}>
      {width ? (
        <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} scrollEnabled={uris.length > 1}
          onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}>
          {uris.map((uri, i) => (
            <Image key={uri} source={{ uri }} accessibilityLabel={uris.length > 1 ? `Shared image ${i + 1} of ${uris.length}` : 'Shared image'}
              accessibilityIgnoresInvertColors resizeMode="contain" style={{ width, height: '100%' }} />
          ))}
        </ScrollView>
      ) : null}
      {badge ? <View style={{ position: 'absolute', top: space.sm, left: space.sm }}>{badge}</View> : null}
      {uris.length > 1 ? (
        <View style={{ position: 'absolute', bottom: space.sm, right: space.sm, backgroundColor: c.scrim, borderRadius: radius.lg, paddingHorizontal: space.sm, paddingVertical: 2 }}>
          <T v="caption" style={{ color: '#fff' }}>{page + 1} / {uris.length}</T>
        </View>
      ) : null}
    </View>
  );
}
