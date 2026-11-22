// A test app with a tenant-like model (`demo.Team`) to bill per team instead of per user.
import { AppConfig } from '@ghuri/core'
import { CharField, type Manager, Model } from '@ghuri/orm'

export class Team extends Model({
  name: new CharField({ maxLength: 100 }),
}) {
  declare static objects: Manager<Team>
  static Meta = { appLabel: 'demo' }
}

export class DemoConfig extends AppConfig {
  name = 'demo'
  override models = { Team }
}
