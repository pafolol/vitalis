import { Composition } from 'remotion';
import { Demo } from './Demo';
import { FPS, totalFrames } from './timeline';

export const Root = () => <Composition id="Demo" component={Demo} durationInFrames={totalFrames} fps={FPS} width={1920} height={1080} />;
