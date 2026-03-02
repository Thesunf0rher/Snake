# 🐍 Build and Deploy Your Own Snake Game

Welcome to the **Snake Game** course! In this interactive tutorial, you will learn how to customize a classic web-based game and deploy it to the internet using GitHub Pages.

By the end of this course, you will have:
- Learned how to edit code in a GitHub repository.
- Customized the game's appearance and difficulty.
- Deployed your own version of the game to share with friends.

---

## Step 1: Play the Game locally (Optional)
Before we start hacking, let's see what we are working with.

This repository contains three main files:
- **`index.html`**: The structure of the webpage.
- **`style.css`**: The styling (colors, fonts, layout).
- **`game.js`**: The logic (movement, score, collision).

If you are using **GitHub Codespaces**, you can right-click `index.html` and select "Open with Live Server" (if the extension is installed) or simply preview the file.

---

## Step 2: Customize the Game Board 🎨
Let's make this game your own by changing the background color.

1. Open the file **`style.css`**.
2. Look for the `canvas` or `body` selector. You should see a `background-color` property.
3. Change the color to something else! 
   - Example: Change `#000` (black) to `#2c3e50` (dark blue) or any hex code you like.
4. **Commit your changes**:
   - Click "Commit changes..."
   - Message: `Update game background color`
   - Click "Commit changes".

> **Explanation**: CSS (Cascading Style Sheets) controls how your game looks. You just modified the visual style of your project!

---

## Step 3: Hack the Snake 🐍
Now, let's dive into the JavaScript logic to change the snake's behavior. We will change the color of the snake itself.

1. Open the file **`game.js`**.
2. Search for the function that draws the snake. Look for a line that sets `ctx.fillStyle`.
   - It typically looks like: `ctx.fillStyle = "lime";` or `ctx.fillStyle = "green";`.
3. Change the color string to your favorite color (e.g., `"cyan"`, `"purple"`, or `"orange"`).
4. **Commit your changes**:
   - Message: `Customize snake color`

> **Challenge**: Can you also find where the "food" (apple) is drawn and change its color to `"red"` or `"gold"`?

---

## Step 4: Adjust the Difficulty ⚡
Is the game too slow? Let's speed it up!

1. Still in **`game.js`**, look for the **game loop** or **speed variable**.
2. You might find a line using `setInterval` or a variable named `speed`.
   - Look for something like: `setInterval(game, 1000/15);` (where 15 is the frames per second).
   - Or a variable like `let speed = 7;`.
3. Increase the number to make the snake move faster (or decrease it to make it slower).
4. **Commit your changes**:
   - Message: `Update game speed`

> **Explanation**: JavaScript controls the game loop. By changing the interval or speed value, you are altering the physics of the game engine.

---

## Step 5: Deploy to GitHub Pages 🚀
Now that you've customized your game, it's time to show it to the world.

1. Go to the **Settings** tab of this repository.
2. On the left sidebar, click on **Pages**.
3. Under **Build and deployment** > **Source**, select **Deploy from a branch**.
4. Under **Branch**, select `main` (or `master`) and keep the folder as `/ (root)`.
5. Click **Save**.

GitHub will now build your website. Wait about 1-2 minutes, then refresh the page. You will see a link at the top (e.g., `https://your-username.github.io/snake-game/`).

**Click the link to play your live game!**

---

## Conclusion
Congratulations! 🎉 You have successfully:
1.  Modified a web project's style and logic.
2.  Used Git to save your versions.
3.  Deployed a live website using GitHub Pages.

**Share your game link with your friends and challenge them to beat your score!**
