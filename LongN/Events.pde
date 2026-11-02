int START_HOUR=17;
int END_HOUR=21;
int MIN_BEFORE_SHUTDOWN = 10;
int  PERFORM_INTERVAL =10;
boolean AUTO_SHUTDOWN = false;

float camScale = 0.8;
int camOffsetX;
int camOffsetY;
float camX = 0;
float camY = -PI/2;
float xmag, ymag = 0;
int lastPlayingNum = 0;

void checkPerform()
{
  if(hour()==END_HOUR && minute()==27 && second()==30)
  {
    //exit();
  }
  if(isStopping)return; 
  //if(hour()<START_HOUR || hour()>END_HOUR) return; 
  if(playingMovieNum==0 && minute()%PERFORM_INTERVAL == 0 && second() == 0 && !forceRunningMode && !forceStoppingMode)
  {
    
    mv[playingMovieNum].jump(0);
    mv[playingMovieNum].pause();
    if(performanceToogle)
      playingMovieNum =1;
    else
      playingMovieNum =2;
    mv[playingMovieNum].play();
    //forceRunningMode=true;
    //showCounter++;
  }
  if(checkVideoOver())
  {
    mv[playingMovieNum].jump(0);
    mv[playingMovieNum].pause();
    
    playingMovieNum =0;
    mv[playingMovieNum].loop();
    
    //for toogle performance
      
    performanceToogle=!performanceToogle;
    
  }
}

void moveCamera()
{
  if(keyPressed && key == CODED)
  {
    if(keyCode ==UP)
      camY-=0.02;
    else if(keyCode ==DOWN)
      camY+=0.02;
    else if(keyCode ==LEFT)
      camX-=0.02;
    else if(keyCode ==RIGHT)
      camX+=0.02;
  }
  scale(camScale);
  float diff = xmag-camX;//xmag-newXmag;
  if (abs(diff) >  0.01) { 
    xmag -= diff/4.0;
  }
  
  diff = ymag-camY;// ymag-newYmag;
  if (abs(diff) >  0.01) { 
    ymag -= diff/4.0; 
  }

  rotateX(-ymag); 
  rotateY(0);
  rotateZ(-xmag);
}

void mouseWheel(MouseEvent event) {
  float e = event.getCount();
  if(e>0)camScale+=0.01;
  else camScale-=0.01;
}

void keyPressed()
{
  //println(key+":"+keyCode);
  if(key=='p' || (key == CODED && keyCode==38))
  {
    if(playingMovieNum==1 || playingMovieNum==2) //go to idle
    {
      mv[playingMovieNum].jump(0);
      mv[playingMovieNum].pause();
      
      playingMovieNum =0;
      mv[playingMovieNum].loop();
      //controlByVideo=false;
    }
    else if(playingMovieNum==0) //go to play
    {
      mv[playingMovieNum].jump(0);
      mv[playingMovieNum].pause();
      performanceToogle=!performanceToogle;
      if(performanceToogle)
        playingMovieNum =1;
      else
        playingMovieNum =2;
      mv[playingMovieNum].play();
      //controlByVideo=true;
    }
  }
  else if(key=='r')
  {
    
    forceRunningMode = !forceRunningMode;
    /*
    if(forceRunningMode)
    {
      mv[playingMovieNum].jump(0);
      mv[playingMovieNum].pause();
    }
    else
    {
      playingMovieNum =0;
      mv[playingMovieNum].loop();
    }
    */
  }
  else if(key=='z')
  {
    //shutdown();
    forceStoppingMode = !forceStoppingMode;
  }
  else if(key=='w')
  {
    mv[0].jump(mv[0].time()+5);
  }
  else if(key=='q')
  {
    mv[0].jump(mv[0].time()-1);
  }
  
}

boolean checkVideoOver()
{
  if(playingMovieNum!=0 && (abs(mv[playingMovieNum].time() - mv[playingMovieNum].duration())<0.1))
  {
    return true;
  }
  return false;
}

boolean isSleeping()
{
  return false;
}

void mousePressed(){
  for(int i=0;i<MOTOR_NUM;i++)
  {
    if(mousePressed && dist(mouseX,mouseY,width-UI_SIZE*2,i*UI_SIZE+18)<15/2)
    {
      transLights[i].isForceStop=!transLights[i].isForceStop;
    }
    if(mousePressed && dist(mouseX,mouseY,width-UI_SIZE*1,i*UI_SIZE+18)<10/2)
    {
        transLights[i].isClockwise=!transLights[i].isClockwise;
    }
  }
}

void shutdown()
{
  //print(dataPath("")+"\\shutdown.bat");
  //launch(dataPath("")+"\\shutdown.bat");
  //launch("shutdown.bat");
  
  
  //exit();
}
