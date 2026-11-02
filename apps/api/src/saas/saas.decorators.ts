import { SetMetadata } from '@nestjs/common';
import type { Feature } from './plans';

export const FEATURE = 'planFeature';
/** SaaS edition: the route needs a plan that includes this feature (self-hosted: always allowed). */
export const RequireFeature = (f: Feature) => SetMetadata(FEATURE, f);
