You are in a directory called devboard. I want you to build this project into a UI based dashboard with following functionality. This will run in browser and both backend and frontend code in this repo.

## Data source

~/.claude/learnings/ - For job based learnings
~/.claude/personal/learnings/ - For learnings via personal coding in ~/dev/learning-shit

On the dashboard there should be two sections on the left sidebar: "Personal", "Work"

### Reading learnings

On work - It should display the latest(paginated) edited learning file topic from job based learnings. You can use the index file in learnings as well. It should show the table with timestamp, filename, learning name(this should be extracted from the top of the file content - the heading) and a third hidden row which can be expanded named "keywords" derived from the learning column of index file
On right side of each row there will button to perform operation on it - Edit, Read, Delete. Read will open an overlay markdown rendered page hovering on top of the dashboard which I can read. Edit will open the file and on top I should be able to see that I am in the file. Here when I make the edits, they should be updated locally. And delete - deletes the file locally.

On personal - Similar behaviour but with personal learnings.

Both personal and work will have a "Search" button at the top right. Here searched keywords will be matched against the filename, learning name and tags and ordered paginated results will be displayed on top how most searches work. Then clicking on one of them should take me to that learning file in new tab and here also by default I get a read only view with two small buttons at top righht - edit and delete.

The learning table will also have a column "Active" which will show green for active claude sessions who are associated with that learning file. The index carries the session id for claude which will be used to figure out if session is active or inactive. Hovering on each - both green and grey(inactive) - show show the session id as well as directory which I can directly copy paste.

## Handling chores at work

Add another panel below the learning table in Work section "Active chores"
Add a command in claude called /start-chore. This is how it will work - When I call /start-chore followed by a work item like review this PR/fix CI here/etc, these are chores and usually dont carry any learning with them (although they can when I run the /handoff command- and if they do then they will show up in the learnings table).
But I want to keep track of these chores. So when call /start-chore ....
Then it should create a new file in ~/.claude/chores with a similar index entry in index.txt carrying session id and everything like learning file. It should auto create filename, file title and the contents of the file will track three sections - "What is done" "What is happening" "What is pending". This should have its own similar fuzzy search. Here also - similar to learning file it will show all columns except Active. There is no concept of active/inactive. It should directly be a column "Session ID". In a session, after a chore is finished I will do /end-chore. This will delete the created file and its index.txt entry. Unlike learnigns which dont want chores to persist long. They should only persist until task is done. And on the dashboard we want to track the active chores at one place fuzzy searchable with their progress. These should not be editable from UI - only deletable and readable(contents). After /start-chore, on every action that moves the progress forward - agent should update the created chore file. These contents will be read on the dashboard to quickly see the state of the things.

One last thing. In personal, on top right there should be a button "Learning Progress Report". This should open a read only view of the learning-report.md in ~/.claude/personal/learnings. Currently there is no such file, but there is a claude command /progress-learning-shit - it stores html files in (~/dev/learning-shit/reports. Open the latest one in new tab when the button "Learning progress report" is clicked.
