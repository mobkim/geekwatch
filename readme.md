## Discord Bot

[**Invite the bot to your server**](https://discord.com/oauth2/authorize?client_id=772690211792224256)


## Introduction
geekwatch looks to help keyboard enthusiasts and amateurs alike stay up to date with the many posts found within [geekhack](https://geekhack.org/), the standard online forum and home to many clickity-clackity hobbyists.

The initial use case was intended for members of the community to have notifications solely for thread publications sent to Discord for a more convenient user experience. However, as more and more vendors, promoters, affiliates, and streamers migrate their primary means of communication to Discord along with the rapidly growing userbase, followers may want to further centralize updates by opting in for notifications that include important individual replies within the threads themselves.

geekwatch tracks and monitors geekhack's forums for new submissions within any forum category (a.k.a. boards) as well as new responses posted by the original poster within any accessible thread (a.k.a. topics). With the bot managing and storing preferences in a separate database, users will be able to have updates relayed to text channels or even DMs through Discord. These messages, in the form of embeds, will include the topic's title, author, author's score (post count), image (if available), timestamp, and more. With simple and easy-to-use commands, users may opt in and out at any time.

In addition to being lightweight in permissions, geekwatch does not require a proprietary account from geekhack to track topics and boards (however having an account is highly recommended).

## Functions

------
**1. Follow any board for newly started topics**
- Each user can watch up to 10 boards
------
**2. Follow any topic for new posts by OP**
- Each user can follow up to 10 topics
------
**3. Manage your board/topic list**
- User can add new interests and remove any existing with simple commands
------
**4. Moderate text channels to limit command usage**
- Admins can unrestrict text channels so any other user can share and add their own interests
- Admins can restrict channels at any time
------
**5. Mass remove trackers in channel/DM**
- Admins can remove all follows/watches within a channel with one command
- Users can also opt out of all trackers via DMs
------

## Commands
*Upon initially inviting the bot, only server admins will have access to every command. Non-admins will be able to call commands only via DM until restrictions are lifted within a text channel.*

-----
`/follow [topic/board url or number]`

Follow a topic for post notifications or a board for newly posted topics

`/following`

Returns your current follow list

`/unfollow [index number]`

Unfollow a topic or board using an index provided by /following

`/unfollow all`

Unfollow all topics and boards

`/help`

Returns the commands list

`/invite`

Returns an invite link for the bot

-----

**ADMIN ONLY**

`/unrestrict`

Lifts restrictions from a channel, allowing any user to call non-admin commands

`/restrict`

Restricts channel, disallowing non-admins to call any non-admin command (all channels are restricted by default)

`/detach`

Removes all instances of channel from every list, including from other users (this can also be called via DM)

------

## Example use cases

------

> User wants to monitor the "Interest Checks" board within geekhack and would like post notifications in their direct messages

User calls a command to geekwatch via DM: `/follow https://geekhack.org/index.php?board=132.0/`

- The user will now receive pings in their DMs whenever there is a new topic posted within "Interest Checks"

------

> User no longer wants to monitor "Interest Checks"

User calls to geekwatch via DM to return current follow list: `/following`

"Interest Checks" is listed with the index of 1

User calls `/unfollow 1` to remove "Interest Checks" from follow list


- User will no longer receive notifications from the board

------

> User (OP of a Groupbuy thread) wants to monitor their own topic/thread so that their new replies within the thread is redirected to a text channel in user's community Discord server

User calls `/follow 105468` within a text channel

- Any user with read access to the channel will now get pings when OP posts a new reply

------

> User (admin) wants to unrestrict a channel so that their friends can post similar topics as they share similar interests

User creates a seperate text channel and calls `/unrestrict`

User agrees to the disclaimer by sending `unrestrict`

- Any other user with permissions can now call any command within the unrestricted text channel

------

> User (admin) has unrestricted a channel, however there is excessive activity in the channel as too many other users have called `/follow` and `/watch`

User wants to re-restrict the channel and remove all trackers

User calls `/restrict` and follows with `/detach`

User agrees to the disclaimer by sending `detach`

- The channel is now restricted and all follows and watches directing to the channel has been removed from all lists

------

## Images
> Board Embeds

![alt text](https://i.imgur.com/EKpzU9y.png)

> Topic Embed

![alt text](https://i.imgur.com/CcvrvUx.png)

![alt text](https://i.imgur.com/VLmiA8Q.png)


## Notes
> Updates will be sent to wherever command was called (channel or DM)

> Each user can track the same board or topic in no more than one channel and DMs simultaneously

> A board or topic cannot be tracked twice within one server

> If the bot is unable to reach the destination (ie. bot attempts to DM you but you no longer share a mutual server or bot attempts to ping the channel but channel has been deleted), all instances of the address will be removed from every list

> Results will likely not be immediate as updates from geekwatch rely solely on forum activity along with user preferences. For testing purposes, it is recommended to watch popular boards and follow active threads (if you are unfamiliar with the forum index, [132](https://geekhack.org/index.php?board=132.0), [70](https://geekhack.org/index.php?board=70.0), [31](https://geekhack.org/index.php?board=31.0), [33](https://geekhack.org/index.php?board=33.0) usually have multiple topics posted daily)

> Updates for newly submitted topics within board 70 [(Group Buys and Preorders)](https://geekhack.org/index.php?board=70.0) may seem delayed if compared against the provided timestamp as they require manual review and approval by forum moderators


## Changelogs
```
Version ?:
- fixed bug causing unresponsiveness when invited to new server
- added a response for unrecognized commands
- further reduced unneccessary bot permissions (4 -> 2)

Version ??:
- improved monitoring folow
- tracker list will now only be returned via DMs
- tracker list will now include a direct link to associated channel (none if DM)
- added an error message for when geekhack's servers are unreachable
- bug fixes

Version v???:
- merged "follow" and "watch" functions
- added helpful text to message upon successful follow
- adjusted commands list
- more bug fixes
```

## Feedback
-----
- DMs @ `H U N C H O#4002` remain open for suggestions and criticism
-----