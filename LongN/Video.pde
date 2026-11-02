import processing.video.*;
final int MOVIE_NUM = 3;
final int videoOffsetX = 0, videoOffsetY = 0;
final int VIDEO_COLOR_BLOCK_X = 8;
final int VIDEO_COLOR_BLOCK_Y = 4;
final int VIDEO_STAR_BLOCK = 4;
final int VIDEO_COLOR_W=VIDEO_COLOR_BLOCK_X*MOTOR_NUM; //70
final int VIDEO_COLOR_H=VIDEO_COLOR_BLOCK_Y*OUTTER_LED_NUM; //4*76=304
//final int VIDEO_STAR_W=VIDEO_STAR_BLOCK*STAR_X_NUM; //120
//final int VIDEO_STAR_H=VIDEO_STAR_BLOCK*STAR_Y_NUM;  //100
final int VIDEO_MOTOR_W = VIDEO_COLOR_BLOCK_X*MOTOR_NUM;
final int VIDEO_MOTOR_H = VIDEO_COLOR_BLOCK_X;
final int VIDEO_W = 56;//VIDEO_COLOR_W;  //56
final int VIDEO_H = VIDEO_COLOR_H + VIDEO_MOTOR_H; //312

int VIDEO_START_X,VIDEO_START_Y;
float motorSamplePosition[][] = new float[MOTOR_NUM][2];
float colorsSamplePosition_outter[][][] = new float[MOTOR_NUM][LED_NUM][2];
//float colorsSamplePosition_inner[][][] = new float[MOTOR_NUM][LED_NUM][2];
float starSamplePosition[][] = new float[200][2];
boolean controlByVideo = true;
float minX=999999, maxX=-999999, minY=999999, maxY=-999999, minZ=999999, maxZ=-999999;

Movie[] mv = new Movie[MOVIE_NUM];
int playingMovieNum = 0;

int forceRunningLimit = 150000;
int forceRunningCounter = 0;
boolean forceRunningToogle=true;


void initVideo()
{
  VIDEO_START_X = 0;
  VIDEO_START_Y = 0;
  
  setVideos();
  calcSamplePosition();
  println("W:"+VIDEO_W+" H:"+VIDEO_H);
  println("VIDEO_COLOR_W:"+VIDEO_COLOR_W+" VIDEO_COLOR_H:"+VIDEO_COLOR_H);
}


void setVideos()
{
  mv[0] = new Movie(this, "idle.mov");
  //mv[0] = new Movie(this, "798_idle.mov");
  mv[1] = new Movie(this, "perform.mov");
  mv[2] = new Movie(this, "performNCTU.mov");

  for(int i=0;i<MOVIE_NUM;i++)
  {
    //if(mv[i]!=null)
    //  mv[i].play();
    //  mv[i].jump(0);
    //  mv[i].pause();
      //mv[i].volume(0);
  }
}

void drawVideo()
{
  noStroke();
  fill(0);
  rect(VIDEO_START_X, VIDEO_START_Y, VIDEO_W, VIDEO_H);
  
  
  if(controlByVideo && !isStopping)
  {
    image(mv[playingMovieNum], VIDEO_START_X, VIDEO_START_Y, VIDEO_W, VIDEO_H);
  

    if(keyPressed){
    //  if(key=='t') 
    //  {
    //    fill(255);
    //    rect(mouseX-20,mouseY-20,40,40);
    //    return;
    //  }
      if(key=='d') fill(255,0,0);
     else if(key=='g') fill(0,255,0);
      else if(key=='b') fill(0,0,255);
      else if(key=='W') fill(255);
    //  else if(key=='B') fill(0);
      rect(VIDEO_START_X, VIDEO_START_Y+VIDEO_MOTOR_H, VIDEO_W, VIDEO_COLOR_H-4);
    }
    
  }
}

void getColor()
{
  for(int i=0;i<MOTOR_NUM;i++)
  {
    for(int j=0;j<OUTTER_LED_NUM;j++)
    {
      if(forceStoppingMode)
        transLights[i].LedColor_outter[OUTTER_LED_NUM-j-1] = color(0);
      else if(forceRunningMode){
        /*
        transLights[i].LedColor_outter[j] = color(255,map(forceRunningCounter,0,forceRunningLimit,255,127),map(forceRunningCounter,0,forceRunningLimit,255,0),map(j,0,OUTTER_LED_NUM,0,255));
        if(forceRunningToogle)forceRunningCounter++;
        else forceRunningCounter--;
        
        if(forceRunningCounter==forceRunningLimit)forceRunningToogle=false;
        if(forceRunningCounter==0)forceRunningToogle=true;
        */
        transLights[i].LedColor_outter[OUTTER_LED_NUM-j-1] = color(255);
        if(j>=OUTTER_LED_NUM-outterCorectionNum)
        {
          transLights[i].LedColor_outter[OUTTER_LED_NUM-j-1]=color(lerpColor(color(0),transLights[i].LedColor_outter[OUTTER_LED_NUM-j-1],max(0.1,map(pow(OUTTER_LED_NUM-j,1),0,pow(outterCorectionNum,1),0,1))));
        }
        else if(j<innerCorectionNum)
        {
          transLights[i].LedColor_outter[OUTTER_LED_NUM-j-1]=color(lerpColor(color(0),transLights[i].LedColor_outter[OUTTER_LED_NUM-j-1],map(j,0,innerCorectionNum,0.3,1)));
        }
        
      }
      else
      {
        transLights[i].LedColor_outter[OUTTER_LED_NUM-j-1] = get(int(colorsSamplePosition_outter[i][j][0]),int(colorsSamplePosition_outter[i][j][1]));
        if(applyMoonCorection && transLights[i].turnningMode==2)//moon color corection
        {
          if(j>=OUTTER_LED_NUM-outterCorectionNum)
          {
            transLights[i].LedColor_outter[OUTTER_LED_NUM-j-1]=color(lerpColor(color(0),transLights[i].LedColor_outter[OUTTER_LED_NUM-j-1],map(pow(OUTTER_LED_NUM-j,1),0,pow(outterCorectionNum,1),0,1)));
          }
          else if(j<innerCorectionNum)
          {
            transLights[i].LedColor_outter[OUTTER_LED_NUM-j-1]=color(lerpColor(color(0),transLights[i].LedColor_outter[OUTTER_LED_NUM-j-1],map(j,0,innerCorectionNum,0.3,1)));
          }
        }
      }
    }
    /*
    for(int j=0;j<INNER_LED_NUM;j++)
    {
      transLights[i].LedColor_inner[j] = get(int(colorsSamplePosition_inner[i][j][0]),int(colorsSamplePosition_inner[i][j][1]));
    }
    */
  }
  /*
  for(int i=0;i<totalStarNum;i++)
  {
    if(forceStoppingMode)
        starColor[i]=color(0);
    else if(forceRunningMode)
      starColor[i]=color(255);
    else
      starColor[i]=get(int(starSamplePosition[i][0]),int(starSamplePosition[i][1]));
  }
  */
}

void getHeight()
{
  for(int i=0;i<MOTOR_NUM;i++)
  {
    if (forceStoppingMode || transLights[i].isForceStop)
      transLights[i].turnningMode = 0;
    else if(forceRunningMode)
      transLights[i].turnningMode = 2;
    else
    {
      float tempB=brightness(get(int(motorSamplePosition[i][0]),int(motorSamplePosition[i][1])));
      if(tempB>200)transLights[i].turnningMode=2;
      else if(tempB>100)transLights[i].turnningMode=1;
      else transLights[i].turnningMode=0;
      //transLights[i].IsTurnning = brightness(get(int(motorSamplePosition[i][0]),int(motorSamplePosition[i][1])))>127;
    }
  }
}


void calcSamplePosition()
{
  for(int i=0;i<MOTOR_NUM;i++)
  {
    motorSamplePosition[i][0] = VIDEO_START_X + 5 + i*VIDEO_COLOR_BLOCK_X +VIDEO_COLOR_BLOCK_X;
    motorSamplePosition[i][1] = VIDEO_START_Y + VIDEO_COLOR_H + 5;
    for(int j=0;j<OUTTER_LED_NUM;j++)
    {
      colorsSamplePosition_outter[i][j][0]= VIDEO_START_X + 5 + i*VIDEO_COLOR_BLOCK_X+VIDEO_COLOR_BLOCK_X; 
      colorsSamplePosition_outter[i][j][1]= VIDEO_START_Y + VIDEO_COLOR_BLOCK_Y*j + 2;
      //colorsSamplePosition_inner[i][j][0]= VIDEO_START_X + 5 + (MOTOR_NUM+i)*VIDEO_COLOR_BLOCK_X;
      //colorsSamplePosition_inner[i][j][1]= VIDEO_START_Y + VIDEO_COLOR_BLOCK_Y*j + 2;
    }
  }
  /*
  for(int i=0;i<totalStarNum;i++)
  {
    starSamplePosition[i][0] = map(starPosition[i][0],minX,maxX,0+VIDEO_STAR_BLOCK/2,VIDEO_STAR_W-VIDEO_STAR_BLOCK/2);
    starSamplePosition[i][1] = VIDEO_COLOR_H+VIDEO_MOTOR_H+map(starPosition[i][1],minY,maxY,0+VIDEO_STAR_BLOCK/2,VIDEO_STAR_H-VIDEO_STAR_BLOCK/2);
  }
  */
  
}

void checkSamplePosition()
{
  noStroke();
  fill(255);
  for(int i=0;i<MOTOR_NUM;i++)
  {
    
    ellipse(motorSamplePosition[i][0],motorSamplePosition[i][1],3,3);
    
    for(int j=0;j<LED_NUM;j++)
    {
      ellipse(colorsSamplePosition_outter[i][j][0],colorsSamplePosition_outter[i][j][1],2,2);
      //ellipse(colorsSamplePosition_inner[i][j][0],colorsSamplePosition_inner[i][j][1],2,2);
    }
  }
  textSize(12); 
  for(int i=0;i<totalStarNum;i++)
  {
    ellipse(starSamplePosition[i][0],starSamplePosition[i][1],3,3);
    
    text(i,starPosition[i][0]/2+400,starPosition[i][1]/3+400);
  }
}

void movieEvent(Movie m)
{
  if(isStopping) return;
  
  m.read();
}

void movieExit()
{
  for(int i=0;i<MOVIE_NUM;i++)
  {
    if(mv[i]!=null)
    {
      mv[i].stop();
      mv[i].dispose();
    }
  }
}
