import { getRepo } from '../../src/services/db';
import { emit } from '../../src/services/events';
import { embeddingRows } from '../../src/services/semantic';
import { resetTestRepo } from '../helpers/uiSetup';

beforeEach(() => resetTestRepo());

test('stored vectors are parsed once and re-read only after the library changes', async () => {
  const repo = await getRepo();
  const spy = jest.spyOn(repo, 'allEmbeddings');
  emit('items'); // start from an empty cache
  await embeddingRows('m');
  await embeddingRows('m');
  expect(spy).toHaveBeenCalledTimes(1);
  await embeddingRows('other-model');
  expect(spy).toHaveBeenCalledTimes(2);
  emit('items');
  await embeddingRows('other-model');
  expect(spy).toHaveBeenCalledTimes(3);
});
